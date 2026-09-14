import { EventEmitter } from 'node:events';
import { SctpAssociation } from '../sctp/association.js';

export class PreNegotiatedDataChannel extends EventEmitter {
  #association;

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

  handleDtlsPayload(plaintext) { this.#association.handleDtlsPayload(plaintext); }

  send(payload, isAudio = true) {
    this.#association.send(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), isAudio);
  }
}
