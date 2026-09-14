import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ContentType, encodeRecord, decodeRecords } from './record.js';
import { HandshakeType, encodeHandshakeMessage, decodeHandshakeFragment, HandshakeReassembler, logicalHandshakeBytes } from './handshake-framing.js';
import * as msg from './handshake-messages.js';
import { generateSelfSignedCert } from './cert-builder.js';
import { generateEcdheKeypair, buildEcdheSignedParams, verifyEcdheParams, signEcdheParams } from './ecdhe.js';
import { deriveMasterSecret, deriveKeyBlock, deriveVerifyData } from './prf.js';
import { encryptRecord, decryptRecord, aes128GcmParams } from './aead.js';
import { createNoopLogger } from '../../shim/core.js';

const RETRANSMIT_TIMEOUTS_MS = [1000, 2000, 4000, 8000, 8000];
const HANDSHAKE_TIMEOUT_MS = 25000;

export class DtlsClient extends EventEmitter {
  #sendDatagram;
  #logger;
  #state = 'idle';
  #messageSeq = 0;
  #reassembler = new HandshakeReassembler();
  #handshakeMessages = [];
  #clientRandom;
  #serverRandom;
  #cookie = Buffer.alloc(0);
  #ecdhe;
  #cert;
  #peerCertificates = [];
  #pendingServerKeyExchange = null;
  #serverRequestedClientCert = false;
  #masterSecret;
  #writeEpoch = 0;
  #writeSeq = 0n;
  #readSeqByEpoch = new Map([[0, -1n]]);
  #keys = null;
  #retransmitTimer = null;
  #retransmitAttempt = 0;
  #lastFlightDatagrams = [];
  #overallTimeoutTimer = null;

  constructor({ sendDatagram, logger }) {
    super();
    this.#sendDatagram = sendDatagram;
    this.#logger = logger ?? createNoopLogger();
  }

  start() {
    this.#clientRandom = randomBytes(32);
    this.#cert = generateSelfSignedCert('wa-voip');
    this.#state = 'wait_hvr';
    this.#sendFlight1();
    this.#overallTimeoutTimer = setTimeout(() => this.#fail(new Error('DTLS handshake timed out overall')), HANDSHAKE_TIMEOUT_MS);
  }

  close() {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
  }

  handleDatagram(datagram) {
    if (this.#state === 'closed') return;
    let records;
    try {
      records = decodeRecords(datagram);
    } catch {
      return;
    }
    for (const record of records) this.#handleRecord(record);
  }

  get isConnected() { return this.#state === 'connected'; }

  encryptApplicationData(plaintext) {
    if (!this.isConnected) throw new Error('DtlsClient.encryptApplicationData: not connected yet');
    const seq = this.#writeSeq++;
    const fragment = encryptRecord({
      writeKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: seq, type: ContentType.APPLICATION_DATA, plaintext,
    });
    return encodeRecord({ type: ContentType.APPLICATION_DATA, epoch: this.#writeEpoch, sequenceNumber: seq, fragment });
  }

  decryptApplicationData(datagram) {
    const out = [];
    let records;
    try { records = decodeRecords(datagram); } catch (e) {

      this.#logger.trace('post-handshake datagram failed to decode as DTLS records', {
        message: e.message, bytes: datagram.length, hex: Buffer.from(datagram).toString('hex')
      });
      return out;
    }
    for (const record of records) {
      if (record.type !== ContentType.APPLICATION_DATA) {
        this.#logger.trace('post-handshake non-application_data record', {
          type: record.type, epoch: record.epoch, seq: record.sequenceNumber, fragmentLen: record.fragment.length
        });
        this.#handleRecord(record);
        continue;
      }
      const readFloor = this.#readSeqByEpoch.get(record.epoch) ?? -1n;
      if (record.sequenceNumber <= readFloor) {
        this.#logger.trace('dropping application_data as replay/duplicate', {
          epoch: record.epoch, seq: record.sequenceNumber.toString(), readFloor: readFloor.toString()
        });
        continue;
      }
      try {
        const plaintext = decryptRecord({
          readKey: this.#keys.serverWriteKey, salt: this.#keys.serverWriteIv,
          epoch: record.epoch, sequenceNumber: record.sequenceNumber, type: record.type, fragment: record.fragment,
        });
        this.#readSeqByEpoch.set(record.epoch, record.sequenceNumber);
        this.#logger.trace('decrypted application_data', {
          epoch: record.epoch, seq: record.sequenceNumber.toString(), plaintextLen: plaintext.length
        });
        out.push(plaintext);
      } catch (e) {

        this.#logger.trace('FAILED to decrypt post-handshake record', {
          epoch: record.epoch, seq: record.sequenceNumber.toString(), fragmentLen: record.fragment.length, message: e.message
        });
      }
    }
    return out;
  }

  #sendFlight1() {
    const chBody = msg.buildClientHello({ clientRandom: this.#clientRandom, cookie: this.#cookie });
    const datagram = this.#packHandshakeMessage(HandshakeType.CLIENT_HELLO, chBody);
    this.#transmitFlight([datagram]);
  }

  #sendFlight3(serverPublicKeyPoint) {
    this.#ecdhe = generateEcdheKeypair();
    const preMasterSecret = this.#ecdhe.computeSharedSecret(serverPublicKeyPoint);
    this.#masterSecret = deriveMasterSecret(preMasterSecret, this.#clientRandom, this.#serverRandom);

    const certPart = this.#serverRequestedClientCert
      ? this.#packHandshakeMessage(HandshakeType.CERTIFICATE, msg.buildCertificate(this.#cert.certDer))
      : Buffer.alloc(0);

    const cke = this.#packHandshakeMessage(HandshakeType.CLIENT_KEY_EXCHANGE, msg.buildClientKeyExchange(this.#ecdhe.publicKeyPoint));

    const certVerifyPart = this.#serverRequestedClientCert
      ? this.#packHandshakeMessage(HandshakeType.CERTIFICATE_VERIFY, msg.buildCertificateVerify({
          signatureScheme: msg.SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256,

          signature: signEcdheParams(this.#cert.privateKey, Buffer.concat(this.#handshakeMessages)),
        }))
      : Buffer.alloc(0);

    this.#keys = deriveKeyBlock(this.#masterSecret, this.#clientRandom, this.#serverRandom, aes128GcmParams);
    const handshakeHashBeforeFinished = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    if (process.env.DTLS_DEBUG) {

      console.log('[ VOIP:diag ] [dtls] handshakeMessages concat hex:', Buffer.concat(this.#handshakeMessages).toString('hex'));
      console.log('[ VOIP:diag ] [dtls] handshakeHashBeforeFinished:', handshakeHashBeforeFinished.toString('hex'));
      console.log('[ VOIP:diag ] [dtls] masterSecret:', this.#masterSecret.toString('hex'));
    }
    const verifyData = deriveVerifyData(this.#masterSecret, 'client finished', handshakeHashBeforeFinished);
    const finishedBody = msg.buildFinished(verifyData);
    const finishedMsgSeq = this.#messageSeq++;
    const finishedLogical = logicalHandshakeBytes({ msgType: HandshakeType.FINISHED, messageSeq: finishedMsgSeq, body: finishedBody });
    const finishedFragments = encodeHandshakeMessage({ msgType: HandshakeType.FINISHED, messageSeq: finishedMsgSeq, body: finishedBody });

    this.#handshakeMessages.push(finishedLogical);

    const ccsRecord = encodeRecord({ type: ContentType.CHANGE_CIPHER_SPEC, epoch: this.#writeEpoch, sequenceNumber: this.#writeSeq++, fragment: Buffer.from([1]) });
    this.#writeEpoch = 1;
    this.#writeSeq = 0n;

    const finishedSeq = this.#writeSeq++;
    const encryptedFinished = encryptRecord({
      writeKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: finishedSeq, type: ContentType.HANDSHAKE, plaintext: finishedFragments[0],
    });
    const finishedRecord = encodeRecord({ type: ContentType.HANDSHAKE, epoch: this.#writeEpoch, sequenceNumber: finishedSeq, fragment: encryptedFinished });

    this.#state = 'wait_server_finished';

    this.#transmitFlight([Buffer.concat([certPart, cke, certVerifyPart, ccsRecord, finishedRecord])]);
  }

  #packHandshakeMessage(msgType, body) {
    const seq = this.#messageSeq++;
    const fragments = encodeHandshakeMessage({ msgType, messageSeq: seq, body });
    this.#handshakeMessages.push(logicalHandshakeBytes({ msgType, messageSeq: seq, body }));
    return Buffer.concat(fragments.map((f) => encodeRecord({ type: ContentType.HANDSHAKE, epoch: this.#writeEpoch, sequenceNumber: this.#writeSeq++, fragment: f })));
  }

  #transmitFlight(datagrams) {
    this.#lastFlightDatagrams = datagrams;
    this.#retransmitAttempt = 0;
    for (const d of datagrams) this.#sendDatagram(d);
    this.#armRetransmit();
  }

  #armRetransmit() {
    clearTimeout(this.#retransmitTimer);
    if (this.#state === 'connected' || this.#state === 'closed') return;
    const timeout = RETRANSMIT_TIMEOUTS_MS[Math.min(this.#retransmitAttempt, RETRANSMIT_TIMEOUTS_MS.length - 1)];
    this.#retransmitTimer = setTimeout(() => {
      this.#retransmitAttempt += 1;
      for (const d of this.#lastFlightDatagrams) this.#sendDatagram(d);
      this.#armRetransmit();
    }, timeout);
  }

  #handleRecord(record) {
    if (record.type === ContentType.HANDSHAKE) {
      if (record.epoch === 0) {
        const decoded = decodeHandshakeFragment(record.fragment);
        const complete = this.#reassembler.addFragment(decoded);
        if (complete) this.#handleHandshakeMessage(complete);
        return;
      }
      if (record.epoch === 1 && this.#state === 'wait_server_finished') {
        this.#tryDecryptServerFinished(record);
        return;
      }
      return;
    }
    if (record.type === ContentType.CHANGE_CIPHER_SPEC) {

      return;
    }
    if (record.type === ContentType.ALERT) {
      this.#fail(new Error(`DTLS alert received (epoch ${record.epoch}): ${record.fragment.toString('hex')}`));
      return;
    }
  }

  #handleHandshakeMessage({ msgType, messageSeq, body }) {
    if (this.#state === 'wait_hvr' && msgType === HandshakeType.HELLO_VERIFY_REQUEST) {
      const { cookie } = msg.parseHelloVerifyRequest(body);
      this.#cookie = cookie;

      this.#handshakeMessages = [];
      this.#messageSeq = 0;
      this.#state = 'wait_server_flight';
      const chBody = msg.buildClientHello({ clientRandom: this.#clientRandom, cookie: this.#cookie });
      const datagram = this.#packHandshakeMessage(HandshakeType.CLIENT_HELLO, chBody);
      this.#transmitFlight([datagram]);
      return;
    }
    if (this.#state === 'wait_server_flight' || this.#state === 'wait_hvr') {
      this.#state = 'wait_server_flight';

      this.#handshakeMessages.push(logicalHandshakeBytes({ msgType, messageSeq, body }));
      if (msgType === HandshakeType.SERVER_HELLO) {
        const parsed = msg.parseServerHello(body);
        this.#serverRandom = parsed.serverRandom;
        return;
      }
      if (msgType === HandshakeType.CERTIFICATE) {
        this.#peerCertificates = msg.parseCertificate(body).certificates;
        return;
      }
      if (msgType === HandshakeType.SERVER_KEY_EXCHANGE) {
        this.#pendingServerKeyExchange = msg.parseServerKeyExchange(body);
        return;
      }
      if (msgType === HandshakeType.CERTIFICATE_REQUEST) {

        this.#serverRequestedClientCert = true;
        return;
      }
      if (msgType === HandshakeType.SERVER_HELLO_DONE) {
        this.#onServerHelloDone();
        return;
      }
    }
  }

  #onServerHelloDone() {
    if (!this.#serverRandom || this.#peerCertificates.length === 0 || !this.#pendingServerKeyExchange) {
      this.#fail(new Error('DTLS: ServerHelloDone arrived before a required prior message'));
      return;
    }
    try {
      const { publicKeyPoint, signature } = this.#pendingServerKeyExchange;
      const signedParams = buildEcdheSignedParams(this.#clientRandom, this.#serverRandom, publicKeyPoint);
      const leaf = new X509Certificate(this.#peerCertificates[0]);
      const ok = verifyEcdheParams(leaf.publicKey, signedParams, signature);
      if (!ok) throw new Error('ServerKeyExchange signature verification failed');
      this.#sendFlight3(publicKeyPoint);
    } catch (e) {
      this.#fail(new Error(`DTLS: ServerKeyExchange verification failed: ${e.message}`));
    }
  }

  #tryDecryptServerFinished(record) {
    const readFloor = this.#readSeqByEpoch.get(1) ?? -1n;
    if (record.sequenceNumber <= readFloor) return;
    let plaintext;
    try {
      plaintext = decryptRecord({
        readKey: this.#keys.serverWriteKey, salt: this.#keys.serverWriteIv,
        epoch: 1, sequenceNumber: record.sequenceNumber, type: ContentType.HANDSHAKE, fragment: record.fragment,
      });
    } catch (e) {
      this.#fail(new Error(`DTLS: failed to decrypt server Finished: ${e.message}`));
      return;
    }
    this.#readSeqByEpoch.set(1, record.sequenceNumber);
    const decoded = decodeHandshakeFragment(plaintext);
    if (decoded.msgType !== HandshakeType.FINISHED) return;
    const { verifyData } = msg.parseFinished(decoded.body);
    const handshakeHash = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    const expected = deriveVerifyData(this.#masterSecret, 'server finished', handshakeHash);
    if (!expected.equals(verifyData)) {
      this.#fail(new Error('DTLS: server Finished verify_data mismatch — handshake integrity check failed'));
      return;
    }
    this.#state = 'connected';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
    this.emit('connected');
  }

  #fail(err) {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
    this.emit('error', err);
  }
}

export class DtlsServer extends EventEmitter {
  #sendDatagram;
  #logger;
  #state = 'idle';
  #messageSeq = 0;
  #reassembler = new HandshakeReassembler();
  #handshakeMessages = [];
  #clientRandom;
  #serverRandom;
  #ecdhe;
  #cert;
  #masterSecret;
  #writeEpoch = 0;
  #writeSeq = 0n;
  #readSeqByEpoch = new Map([[0, -1n]]);
  #keys = null;
  #retransmitTimer = null;
  #retransmitAttempt = 0;
  #lastFlightDatagrams = [];
  #overallTimeoutTimer = null;

  constructor({ sendDatagram, logger }) {
    super();
    this.#sendDatagram = sendDatagram;
    this.#logger = logger ?? createNoopLogger();
  }

  startPassive() {
    this.#cert = generateSelfSignedCert('wa-voip');
    this.#state = 'wait_client_hello';
    this.#overallTimeoutTimer = setTimeout(() => this.#fail(new Error('DTLS handshake timed out overall (passive/server role)')), HANDSHAKE_TIMEOUT_MS);
  }

  close() {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
  }

  handleDatagram(datagram) {
    if (this.#state === 'closed') return;
    let records;
    try {
      records = decodeRecords(datagram);
    } catch {
      return;
    }
    for (const record of records) this.#handleRecord(record);
  }

  get isConnected() { return this.#state === 'connected'; }

  encryptApplicationData(plaintext) {
    if (!this.isConnected) throw new Error('DtlsServer.encryptApplicationData: not connected yet');
    const seq = this.#writeSeq++;
    const fragment = encryptRecord({
      writeKey: this.#keys.serverWriteKey, salt: this.#keys.serverWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: seq, type: ContentType.APPLICATION_DATA, plaintext,
    });
    return encodeRecord({ type: ContentType.APPLICATION_DATA, epoch: this.#writeEpoch, sequenceNumber: seq, fragment });
  }

  decryptApplicationData(datagram) {
    const out = [];
    let records;
    try { records = decodeRecords(datagram); } catch (e) {
      this.#logger.trace('post-handshake datagram failed to decode as DTLS records', {
        message: e.message, bytes: datagram.length, hex: Buffer.from(datagram).toString('hex')
      });
      return out;
    }
    for (const record of records) {
      if (record.type !== ContentType.APPLICATION_DATA) {
        this.#logger.trace('post-handshake non-application_data record', {
          type: record.type, epoch: record.epoch, seq: record.sequenceNumber, fragmentLen: record.fragment.length
        });
        this.#handleRecord(record);
        continue;
      }
      const readFloor = this.#readSeqByEpoch.get(record.epoch) ?? -1n;
      if (record.sequenceNumber <= readFloor) continue;
      try {
        const plaintext = decryptRecord({
          readKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
          epoch: record.epoch, sequenceNumber: record.sequenceNumber, type: record.type, fragment: record.fragment,
        });
        this.#readSeqByEpoch.set(record.epoch, record.sequenceNumber);
        out.push(plaintext);
      } catch (e) {
        this.#logger.trace('FAILED to decrypt post-handshake record', {
          epoch: record.epoch, seq: record.sequenceNumber.toString(), fragmentLen: record.fragment.length, message: e.message
        });
      }
    }
    return out;
  }

  #handleRecord(record) {
    if (record.type === ContentType.HANDSHAKE) {
      if (record.epoch === 0) {
        const decoded = decodeHandshakeFragment(record.fragment);
        const complete = this.#reassembler.addFragment(decoded);
        if (complete) this.#handleHandshakeMessage(complete);
        return;
      }
      if (record.epoch === 1 && this.#state === 'wait_client_finished') {
        this.#tryDecryptClientFinished(record);
        return;
      }
      return;
    }
    if (record.type === ContentType.CHANGE_CIPHER_SPEC) return;
    if (record.type === ContentType.ALERT) {
      this.#fail(new Error(`DTLS alert received (epoch ${record.epoch}): ${record.fragment.toString('hex')}`));
      return;
    }
  }

  #handleHandshakeMessage({ msgType, messageSeq, body }) {
    if (this.#state === 'wait_client_hello' && msgType === HandshakeType.CLIENT_HELLO) {
      this.#handshakeMessages.push(logicalHandshakeBytes({ msgType, messageSeq, body }));
      const { clientRandom } = msg.parseClientHello(body);
      this.#clientRandom = clientRandom;
      this.#sendFlight2();
      return;
    }
    if (this.#state === 'wait_client_finished' && msgType === HandshakeType.CLIENT_KEY_EXCHANGE) {
      this.#handshakeMessages.push(logicalHandshakeBytes({ msgType, messageSeq, body }));
      const { publicKeyPoint } = msg.parseClientKeyExchange(body);
      this.#finishKeyExchange(publicKeyPoint);
      return;
    }
  }

  #sendFlight2() {
    this.#serverRandom = randomBytes(32);
    this.#ecdhe = generateEcdheKeypair();

    const shBody = msg.buildServerHello({ serverRandom: this.#serverRandom, cipherSuite: msg.CIPHER_SUITE_ECDHE_ECDSA_AES_128_GCM_SHA256 });
    const shDatagram = this.#packHandshakeMessage(HandshakeType.SERVER_HELLO, shBody);

    const certBody = msg.buildCertificate(this.#cert.certDer);
    const certDatagram = this.#packHandshakeMessage(HandshakeType.CERTIFICATE, certBody);

    const signedParams = buildEcdheSignedParams(this.#clientRandom, this.#serverRandom, this.#ecdhe.publicKeyPoint);
    const signature = signEcdheParams(this.#cert.privateKey, signedParams);
    const skeBody = msg.buildServerKeyExchange({ publicKeyPoint: this.#ecdhe.publicKeyPoint, signature });
    const skeDatagram = this.#packHandshakeMessage(HandshakeType.SERVER_KEY_EXCHANGE, skeBody);

    const shdBody = msg.buildServerHelloDone();
    const shdDatagram = this.#packHandshakeMessage(HandshakeType.SERVER_HELLO_DONE, shdBody);

    this.#state = 'wait_client_finished';
    this.#transmitFlight([Buffer.concat([shDatagram, certDatagram, skeDatagram, shdDatagram])]);
  }

  #finishKeyExchange(clientPublicKeyPoint) {
    try {
      const preMasterSecret = this.#ecdhe.computeSharedSecret(clientPublicKeyPoint);
      this.#masterSecret = deriveMasterSecret(preMasterSecret, this.#clientRandom, this.#serverRandom);
      this.#keys = deriveKeyBlock(this.#masterSecret, this.#clientRandom, this.#serverRandom, aes128GcmParams);
    } catch (e) {
      this.#fail(new Error(`DTLS: server-side key derivation failed: ${e.message}`));
    }

  }

  #tryDecryptClientFinished(record) {
    const readFloor = this.#readSeqByEpoch.get(1) ?? -1n;
    if (record.sequenceNumber <= readFloor) return;
    if (!this.#keys) {

      this.#logger.trace('client Finished arrived before key derivation completed', {});
      return;
    }
    let plaintext;
    try {
      plaintext = decryptRecord({
        readKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
        epoch: 1, sequenceNumber: record.sequenceNumber, type: ContentType.HANDSHAKE, fragment: record.fragment,
      });
    } catch (e) {
      this.#fail(new Error(`DTLS: failed to decrypt client Finished: ${e.message}`));
      return;
    }
    this.#readSeqByEpoch.set(1, record.sequenceNumber);
    const decoded = decodeHandshakeFragment(plaintext);
    if (decoded.msgType !== HandshakeType.FINISHED) return;
    const { verifyData } = msg.parseFinished(decoded.body);

    const handshakeHashForClient = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    const expected = deriveVerifyData(this.#masterSecret, 'client finished', handshakeHashForClient);
    if (!expected.equals(verifyData)) {
      this.#fail(new Error('DTLS: client Finished verify_data mismatch — handshake integrity check failed'));
      return;
    }

    const clientFinishedLogical = logicalHandshakeBytes({ msgType: decoded.msgType, messageSeq: decoded.messageSeq, body: decoded.body });
    this.#handshakeMessages.push(clientFinishedLogical);
    this.#sendServerFinished();
  }

  #sendServerFinished() {
    const handshakeHash = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    const verifyData = deriveVerifyData(this.#masterSecret, 'server finished', handshakeHash);
    const finishedBody = msg.buildFinished(verifyData);
    const finishedMsgSeq = this.#messageSeq++;
    const finishedFragments = encodeHandshakeMessage({ msgType: HandshakeType.FINISHED, messageSeq: finishedMsgSeq, body: finishedBody });

    const ccsRecord = encodeRecord({ type: ContentType.CHANGE_CIPHER_SPEC, epoch: this.#writeEpoch, sequenceNumber: this.#writeSeq++, fragment: Buffer.from([1]) });
    this.#writeEpoch = 1;
    this.#writeSeq = 0n;

    const finishedSeq = this.#writeSeq++;
    const encryptedFinished = encryptRecord({
      writeKey: this.#keys.serverWriteKey, salt: this.#keys.serverWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: finishedSeq, type: ContentType.HANDSHAKE, plaintext: finishedFragments[0],
    });
    const finishedRecord = encodeRecord({ type: ContentType.HANDSHAKE, epoch: this.#writeEpoch, sequenceNumber: finishedSeq, fragment: encryptedFinished });

    this.#state = 'connected';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
    this.#transmitFlight([Buffer.concat([ccsRecord, finishedRecord])]);
    this.emit('connected');
  }

  #packHandshakeMessage(msgType, body) {
    const seq = this.#messageSeq++;
    const fragments = encodeHandshakeMessage({ msgType, messageSeq: seq, body });
    this.#handshakeMessages.push(logicalHandshakeBytes({ msgType, messageSeq: seq, body }));
    return Buffer.concat(fragments.map((f) => encodeRecord({ type: ContentType.HANDSHAKE, epoch: this.#writeEpoch, sequenceNumber: this.#writeSeq++, fragment: f })));
  }

  #transmitFlight(datagrams) {
    this.#lastFlightDatagrams = datagrams;
    this.#retransmitAttempt = 0;
    for (const d of datagrams) this.#sendDatagram(d);
    this.#armRetransmit();
  }

  #armRetransmit() {
    clearTimeout(this.#retransmitTimer);
    if (this.#state === 'connected' || this.#state === 'closed') return;
    const timeout = RETRANSMIT_TIMEOUTS_MS[Math.min(this.#retransmitAttempt, RETRANSMIT_TIMEOUTS_MS.length - 1)];
    this.#retransmitTimer = setTimeout(() => {
      this.#retransmitAttempt += 1;
      for (const d of this.#lastFlightDatagrams) this.#sendDatagram(d);
      this.#armRetransmit();
    }, timeout);
  }

  #fail(err) {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearTimeout(this.#overallTimeoutTimer);
    this.emit('error', err);
  }
}
