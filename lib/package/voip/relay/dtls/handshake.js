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

// Full DTLS 1.2 client handshake, playing the client role against a relay
// that (per meowcaller's Go reference, relay.go: dtls.ClientWithOptions +
// WithInsecureSkipVerify(true)) is always the DTLS *server* and never
// validates our certificate. We mirror that asymmetry: we DO verify the
// relay's ServerKeyExchange signature against its certificate (cheap, and
// catches wire-format bugs on our end fast), but we do NOT validate the
// certificate itself against any CA — there is none; "media auth is HBH
// SRTP, not DTLS" per the Go source comment.
//
// Flow (RFC 6347 §4.2.1 "stateless" cookie exchange, RFC 5246 §7.3 for the
// rest):
//   -> ClientHello (empty cookie)
//   <- HelloVerifyRequest (cookie)
//   -> ClientHello (with cookie)                    [RFC 6347 §4.2.1: HelloVerifyRequest is NOT part of the handshake hash / message_seq count, so this restarts flight 1]
//   <- ServerHello, Certificate, ServerKeyExchange, ServerHelloDone
//   -> ClientKeyExchange, [ChangeCipherSpec], Finished
//   <- [ChangeCipherSpec], Finished
//   handshake complete; epoch 1 application_data now flows both ways.

const RETRANSMIT_TIMEOUTS_MS = [1000, 2000, 4000, 8000, 8000]; // RFC 6347 §4.2.4 doubling backoff, capped
const HANDSHAKE_TIMEOUT_MS = 25000; // overall ceiling; caller's relay-transport.js CONNECTION_TIMEOUT_MS (20s) is meant to fire first in practice

/**
 * @param {(datagram: Buffer) => void} sendDatagram - caller's UDP send
 * Emits: 'connected', 'error'
 */
export class DtlsClient extends EventEmitter {
  #sendDatagram;
  #logger;
  #state = 'idle'; // idle -> wait_hvr -> wait_server_flight -> wait_server_finished -> connected -> closed
  #messageSeq = 0;
  #reassembler = new HandshakeReassembler();
  #handshakeMessages = []; // logical (unfragmented) bytes of every message sent/received, in order, for Finished hashing
  #clientRandom;
  #serverRandom;
  #cookie = Buffer.alloc(0);
  #ecdhe;
  #cert;
  #peerCertificates = [];
  #pendingServerKeyExchange = null;
  #serverRequestedClientCert = false; // set on CertificateRequest (msgType 13); see #sendFlight3
  #masterSecret;
  #writeEpoch = 0;
  #writeSeq = 0n;
  #readSeqByEpoch = new Map([[0, -1n]]);
  #keys = null; // { clientWriteKey, serverWriteKey, clientWriteIv, serverWriteIv }
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

  /** Feed one received UDP datagram in. Call this from the caller's socket 'message' handler. */
  handleDatagram(datagram) {
    if (this.#state === 'closed') return;
    let records;
    try {
      records = decodeRecords(datagram);
    } catch {
      return; // malformed datagram on an unreliable transport: drop, don't crash
    }
    for (const record of records) this.#handleRecord(record);
  }

  /** True once the handshake has finished and application data can flow. */
  get isConnected() { return this.#state === 'connected'; }

  /** Encrypts one application_data payload for sending (epoch 1+). Throws if not yet connected. */
  encryptApplicationData(plaintext) {
    if (!this.isConnected) throw new Error('DtlsClient.encryptApplicationData: not connected yet');
    const seq = this.#writeSeq++;
    const fragment = encryptRecord({
      writeKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: seq, type: ContentType.APPLICATION_DATA, plaintext,
    });
    return encodeRecord({ type: ContentType.APPLICATION_DATA, epoch: this.#writeEpoch, sequenceNumber: seq, fragment });
  }

  /** Decrypts any application_data records found in one received datagram. Non-application-data records (e.g. a stray alert) are handled internally and produce no output here. */
  decryptApplicationData(datagram) {
    const out = [];
    let records;
    try { records = decodeRecords(datagram); } catch (e) {
      // Was a bare console.log — if the relay sends anything post-handshake
      // that fails even to parse as DTLS records, this was previously a
      // silent drop, matching the same blind spot the SCTP layer had before
      // its own fix.
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
        // Was a bare console.log — if the relay IS replying post-handshake
        // but every reply lands here, that's the actual bug, not "the relay
        // never answers" as it looks from the outside with no visibility
        // into this catch.
        this.#logger.trace('FAILED to decrypt post-handshake record', {
          epoch: record.epoch, seq: record.sequenceNumber.toString(), fragmentLen: record.fragment.length, message: e.message
        });
      }
    }
    return out;
  }

  // ---- internal: flight construction ----

  #sendFlight1() {
    const chBody = msg.buildClientHello({ clientRandom: this.#clientRandom, cookie: this.#cookie });
    const datagram = this.#packHandshakeMessage(HandshakeType.CLIENT_HELLO, chBody);
    this.#transmitFlight([datagram]);
  }

  #sendFlight3(serverPublicKeyPoint) {
    this.#ecdhe = generateEcdheKeypair();
    const preMasterSecret = this.#ecdhe.computeSharedSecret(serverPublicKeyPoint);
    this.#masterSecret = deriveMasterSecret(preMasterSecret, this.#clientRandom, this.#serverRandom);

    // RFC 5246 §7.4.6/§7.4.8: if (and only if) the server sent a
    // CertificateRequest, our response flight must lead with our own
    // Certificate — before ClientKeyExchange, not after — and then, since
    // our cert is ECDSA-capable, follow ClientKeyExchange with a
    // CertificateVerify signing the transcript so far. This whole branch
    // used to not exist at all: buildCertificate() was written and never
    // called, and CertificateRequest (msgType 13) was silently ignored,
    // so ClientKeyExchange always arrived first regardless. A relay that
    // actually asks for a client cert sees that as an out-of-order/
    // unexpected handshake message and sends a fatal alert.
    const certPart = this.#serverRequestedClientCert
      ? this.#packHandshakeMessage(HandshakeType.CERTIFICATE, msg.buildCertificate(this.#cert.certDer))
      : Buffer.alloc(0);

    const cke = this.#packHandshakeMessage(HandshakeType.CLIENT_KEY_EXCHANGE, msg.buildClientKeyExchange(this.#ecdhe.publicKeyPoint));

    const certVerifyPart = this.#serverRequestedClientCert
      ? this.#packHandshakeMessage(HandshakeType.CERTIFICATE_VERIFY, msg.buildCertificateVerify({
          signatureScheme: msg.SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256,
          // Signs the raw (unhashed) transcript so far — Certificate and
          // ClientKeyExchange included, CertificateVerify's own bytes
          // excluded since it can't sign itself. signEcdheParams hashes
          // internally (createSign('SHA256')), same as every other
          // signature in this file — do not pre-hash here too.
          signature: signEcdheParams(this.#cert.privateKey, Buffer.concat(this.#handshakeMessages)),
        }))
      : Buffer.alloc(0);

    // Key block derives now (before Finished is built), since Finished is
    // the first record sent under the new epoch.
    this.#keys = deriveKeyBlock(this.#masterSecret, this.#clientRandom, this.#serverRandom, aes128GcmParams);
    const handshakeHashBeforeFinished = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    if (process.env.DTLS_DEBUG) {
      // Set DTLS_DEBUG=1 to dump the exact bytes/hash feeding Finished, if a
      // future relay firmware/version ever disagrees with us again — this is
      // what caught the missing-server-messages-in-the-hash bug during
      // development (see the integration test in dtls/README, or just diff
      // this against a peer's equivalent log).
      console.log('[ VOIP:diag ] [dtls] handshakeMessages concat hex:', Buffer.concat(this.#handshakeMessages).toString('hex'));
      console.log('[ VOIP:diag ] [dtls] handshakeHashBeforeFinished:', handshakeHashBeforeFinished.toString('hex'));
      console.log('[ VOIP:diag ] [dtls] masterSecret:', this.#masterSecret.toString('hex'));
    }
    const verifyData = deriveVerifyData(this.#masterSecret, 'client finished', handshakeHashBeforeFinished);
    const finishedBody = msg.buildFinished(verifyData);
    const finishedMsgSeq = this.#messageSeq++;
    const finishedLogical = logicalHandshakeBytes({ msgType: HandshakeType.FINISHED, messageSeq: finishedMsgSeq, body: finishedBody });
    const finishedFragments = encodeHandshakeMessage({ msgType: HandshakeType.FINISHED, messageSeq: finishedMsgSeq, body: finishedBody });
    // RFC 5246 §7.4.9: the hash used for verify_data covers messages "up to
    // but not including this message" — so Finished's own logical bytes are
    // recorded AFTER computing verifyData above, but still before the
    // server's Finished hash is computed later (which must include ours).
    this.#handshakeMessages.push(finishedLogical);

    const ccsRecord = encodeRecord({ type: ContentType.CHANGE_CIPHER_SPEC, epoch: this.#writeEpoch, sequenceNumber: this.#writeSeq++, fragment: Buffer.from([1]) });
    this.#writeEpoch = 1;
    this.#writeSeq = 0n; // sequence number resets per epoch, RFC 6347 §4.1

    const finishedSeq = this.#writeSeq++;
    const encryptedFinished = encryptRecord({
      writeKey: this.#keys.clientWriteKey, salt: this.#keys.clientWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: finishedSeq, type: ContentType.HANDSHAKE, plaintext: finishedFragments[0],
    });
    const finishedRecord = encodeRecord({ type: ContentType.HANDSHAKE, epoch: this.#writeEpoch, sequenceNumber: finishedSeq, fragment: encryptedFinished });

    this.#state = 'wait_server_finished';
    // [Certificate +] ClientKeyExchange [+ CertificateVerify] (epoch 0) +
    // ChangeCipherSpec + Finished (epoch 1) can be coalesced into one UDP
    // datagram — DTLS peers are required to accept multiple records per
    // datagram (RFC 6347 §4.1).
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

  // ---- internal: record/message dispatch ----

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
      // Purely informational at this layer: the actual epoch-1 read key
      // only matters once we try to decrypt the Finished/app-data that
      // follows, which #tryDecryptServerFinished / decryptApplicationData
      // do directly by epoch number — no separate flag needed.
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
      // RFC 6347 §4.2.1: HelloVerifyRequest is not counted in the message_seq
      // sequence or the handshake hash — discard the flight-1 ClientHello we
      // logged and restart message_seq at 0 for the real flight.
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
      // Every server handshake message (other than HelloVerifyRequest, handled
      // above and explicitly excluded per RFC 6347 §4.2.1) must join the
      // running hash used for both sides' Finished verify_data (RFC 5246
      // §7.4.9: "all handshake messages sent or received starting at
      // ClientHello... up to but not including this Finished message"). This
      // was previously missing entirely — ServerHello/Certificate/
      // ServerKeyExchange/ServerHelloDone were parsed for their fields but
      // never logged, which made both sides' Finished hash computations
      // silently diverge (caught by the integration test against the
      // independent Python DTLS server: "CLIENT FINISHED MISMATCH").
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
        // We only ever offer one client cert (self-signed, ECDSA P-256, see
        // cert-builder.js) and don't parse which CA/algorithms the relay
        // claims to accept in this message's body — same "don't parse what
        // we don't act on" stance as the rest of this file. Whatever it
        // asked for, we answer with our one cert in #sendFlight3.
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
    if (record.sequenceNumber <= readFloor) return; // replay/duplicate
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

// ============================================================================
// DtlsServer — the DTLS *server* role: waits for the peer to send ClientHello
// first, then answers with ServerHello/Certificate/ServerKeyExchange/
// ServerHelloDone, and finally verifies the peer's Finished and sends our own.
//
// Why this exists at all: DtlsClient above is the role meowcaller's Go
// reference (relay.go: dtls.ClientWithOptions) uses, and its wire format was
// independently verified correct — byte-for-byte checksums, and even
// `openssl s_client` sending the exact same SCTP INIT bytes over its own
// DTLS-client-role handshake got the identical "relay never responds at the
// SCTP layer" result ours did. Every other layer above transport has since
// been checked and either fixed (SSRC slot, STUN token/key mixup) or added
// (the ICE STUN Binding step, in both directions, kept continuously fresh)
// — and SCTP still never got a response.
//
// The one remaining, empirically-grounded difference: the ONLY reference that
// is *confirmed working* against today's real relays (not just "should work"
// per an older, explicitly-unvalidated Go/Rust port) is this project's own
// wrtc-based implementation, and its SDP munging forces `a=setup:passive` —
// meaning WE are the DTLS server and the RELAY is the DTLS client, the exact
// opposite of what DtlsClient (and meowcaller) does. Given wire format,
// ICE binding, and consent freshness are all now ruled out or fixed, and
// this is the one variable that differs between "confirmed working" and
// "confirmed not," it's the remaining candidate worth building.
//
// Flow (mirrors DtlsClient's docstring, reversed):
//   <- ClientHello
//   -> ServerHello, Certificate, ServerKeyExchange, ServerHelloDone
//      (No HelloVerifyRequest/cookie round-trip: RFC 6347 makes that
//      RECOMMENDED, not mandatory, and a compliant DTLS client must accept a
//      server skipping straight to ServerHello. Skipping it keeps this
//      state machine smaller — see buildHelloVerifyRequest's doc comment if
//      a future relay generation ever turns out to require it.)
//   <- ClientKeyExchange, [ChangeCipherSpec], Finished
//   -> [ChangeCipherSpec], Finished
//   handshake complete; epoch 1 application_data now flows both ways.
export class DtlsServer extends EventEmitter {
  #sendDatagram;
  #logger;
  #state = 'idle'; // idle -> wait_client_hello -> wait_client_finished -> connected -> closed
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

  /** Begins the server role: does NOT send anything yet — waits for the peer's ClientHello. */
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

  /** Encrypts one application_data payload for sending (epoch 1+). Note the
   * write key here is serverWriteKey — the reverse of DtlsClient, which
   * writes with clientWriteKey. Everything above this layer (relay-transport
   * equivalent) only ever calls whichever role object it constructed, so
   * this asymmetry is invisible to callers. */
  encryptApplicationData(plaintext) {
    if (!this.isConnected) throw new Error('DtlsServer.encryptApplicationData: not connected yet');
    const seq = this.#writeSeq++;
    const fragment = encryptRecord({
      writeKey: this.#keys.serverWriteKey, salt: this.#keys.serverWriteIv,
      epoch: this.#writeEpoch, sequenceNumber: seq, type: ContentType.APPLICATION_DATA, plaintext,
    });
    return encodeRecord({ type: ContentType.APPLICATION_DATA, epoch: this.#writeEpoch, sequenceNumber: seq, fragment });
  }

  /** Mirror of DtlsClient.decryptApplicationData — reads with clientWriteKey
   * (the peer, in this role, writes with its client key). */
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

  // ---- internal: record/message dispatch ----

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
    if (record.type === ContentType.CHANGE_CIPHER_SPEC) return; // see DtlsClient's identical comment
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
    // Nothing sent here — we wait for the client's [ChangeCipherSpec,] Finished
    // (epoch 1), handled by #tryDecryptClientFinished, before responding with
    // our own. #handleRecord already routes epoch-1 HANDSHAKE records to that
    // once #state is 'wait_client_finished' (set in #sendFlight2).
  }

  #tryDecryptClientFinished(record) {
    const readFloor = this.#readSeqByEpoch.get(1) ?? -1n;
    if (record.sequenceNumber <= readFloor) return;
    if (!this.#keys) {
      // Finished arrived before we finished deriving keys from
      // ClientKeyExchange — shouldn't happen given DTLS's strict message
      // ordering within a flight, but don't crash if a relay ever pipelines
      // unexpectedly.
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
    // Client's verify_data covers everything up to but not including the
    // client's own Finished — i.e. exactly what's in #handshakeMessages
    // right now (ServerHello..ServerHelloDone, ClientKeyExchange).
    const handshakeHashForClient = createHash('sha256').update(Buffer.concat(this.#handshakeMessages)).digest();
    const expected = deriveVerifyData(this.#masterSecret, 'client finished', handshakeHashForClient);
    if (!expected.equals(verifyData)) {
      this.#fail(new Error('DTLS: client Finished verify_data mismatch — handshake integrity check failed'));
      return;
    }
    // Now record the client's Finished too, before computing OUR OWN
    // verify_data — RFC 5246 §7.4.9: the server's Finished MAC covers all
    // messages up to but not including the SERVER's own Finished, which by
    // definition includes the client's Finished that just arrived. Mirrors
    // DtlsClient's #onServerHelloDone/#sendFlight3 asymmetry in reverse.
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

    // Unlike DtlsClient (which still has to wait for the server's Finished
    // after this point), sending our Finished here IS the last step of the
    // handshake for the server role — RFC 5246's flow ends with the server's
    // Finished, no further reply expected. Go straight to 'connected'.
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
