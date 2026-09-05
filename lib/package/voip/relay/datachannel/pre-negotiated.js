import { EventEmitter } from 'node:events';
import { SctpAssociation } from '../sctp/association.js';

// Pre-negotiated WebRTC DataChannel (RFC 8831 §5: "negotiated" mode skips
// the DCEP DATA_CHANNEL_OPEN/ACK handshake entirely — both sides already
// agree out-of-band on stream id, label, and parameters). Stream id 0,
// label "pre-negotiated", matching meowcaller's Go reference exactly
// (relay.go: DataChannelLabel = "pre-negotiated", datachannel.Dial(assoc, 0, ...)).
// This class is a thin event-shape adapter over SctpAssociation so
// relay-transport.js can swap `new RTCPeerConnection(...).createDataChannel(...)`
// for `new PreNegotiatedDataChannel(...)` with matching send()/on('message')/
// on('open') semantics, minimizing the diff at the call site.

export class PreNegotiatedDataChannel extends EventEmitter {
  #association;

  /** @param {{ sendDtlsPayload: (plaintext: Buffer) => void, logger?: object }} params - same
   * shape SctpAssociation takes; caller wires this to DtlsClient's
   * encryptApplicationData + UDP send. */
  constructor({ sendDtlsPayload, logger }) {
    super();
    this.#association = new SctpAssociation({ sendDtlsPayload, logger });
    this.#association.on('connected', () => this.emit('open'));
    this.#association.on('message', (payload) => this.emit('message', payload));
    this.#association.on('error', (err) => this.emit('error', err));
  }

  start() { this.#association.start(); }
  close() { this.#association.close(); }
  getSendBacklog() { return this.#association.getSendBacklog(); }
  get readyState() { return this.#association.isConnected ? 'open' : 'connecting'; }

  /** Feed one decrypted DTLS application_data payload in — call this from
   * DtlsClient's 'data' handling (relay-transport.js composes this). */
  handleDtlsPayload(plaintext) { this.#association.handleDtlsPayload(plaintext); }

  /** Sends one binary message on the pre-negotiated stream (PPID 53, WebRTC
   * Binary — handled inside SctpAssociation.send). */
  send(payload) { this.#association.send(Buffer.isBuffer(payload) ? payload : Buffer.from(payload)); }
}
