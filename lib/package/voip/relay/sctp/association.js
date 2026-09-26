import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../../shim/core.js';
import * as sctp from './wire.js';

const SCTP_PORT = 5000;
const RETRANSMIT_TIMEOUT_MS = 1000;
const VIDEO_RETRANSMIT_TIMEOUT_MS = 200;
const MAX_INIT_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 5000;

const SEND_WINDOW_SIZE = 32;
const MAX_VIDEO_QUEUE_AGE_MS = 400;
const MAX_QUEUED_VIDEO_PACKETS = 200;
const MAX_QUEUED_AUDIO_FRAMES = 20;
const MAX_VIDEO_IN_FLIGHT = 8;
const STALE_GAP_TSN_LIMIT = 512;

function randomUint32() {
  return randomBytes(4).readUInt32BE(0);
}

export class SctpAssociation extends EventEmitter {
  #sendDtlsPayload;
  #logger;
  #state = 'idle';

  #myTag = randomUint32();
  #peerVerificationTag = 0;
  #initialTsn = randomUint32();
  #nextTsn;
  #peerInitialTsn = 0;
  #cumulativeAckReceived = -1;
  #stateCookie = null;
  #retransmitTimer = null;
  #initRetries = 0;
  #heartbeatTimer = null;
  #outboundStreamSeq = 0;
  #outboundVideoStreamSeq = 0;
  #inboundExpectedStreamSeq = 0;
  #reorderBuffer = new Map();
  #inFlight = new Map();
  #videoInFlightCount = 0;
  #audioQueue = [];
  #videoQueue = [];
  #inboundCumulativeTsn = -1;
  #inboundReceivedAheadTsns = new Set();

  constructor({ sendDtlsPayload, logger }) {
    super();
    this.#sendDtlsPayload = sendDtlsPayload;
    this.#logger = logger ?? createNoopLogger();
    this.#nextTsn = this.#initialTsn;
  }

  start() {
    this.#state = 'wait_init_ack';
    this.#sendInit();
  }

  close() {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearInterval(this.#heartbeatTimer);
    for (const entry of this.#inFlight.values()) clearTimeout(entry.timer);
    this.#inFlight.clear();
    this.#videoInFlightCount = 0;
    this.#audioQueue = [];
    this.#videoQueue = [];
    this.#reorderBuffer.clear();
    this.#inboundReceivedAheadTsns.clear();
  }

  get isConnected() { return this.#state === 'connected'; }

  getSendBacklog() {
    return {
      queued: this.#audioQueue.length + this.#videoQueue.length,
      queuedAudio: this.#audioQueue.length,
      queuedVideo: this.#videoQueue.length,
      inFlight: this.#inFlight.size,
      retransmits: this.#retransmitCount
    };
  }

  send(payload, isAudio = true) {
    if (this.#state === 'closed') return;
    if (isAudio) {
      this.#audioQueue.push(payload);
      if (this.#audioQueue.length > MAX_QUEUED_AUDIO_FRAMES) {
        this.#audioQueue.splice(0, this.#audioQueue.length - MAX_QUEUED_AUDIO_FRAMES);
      }
    } else {
      const now = Date.now();
      this.#videoQueue.push({ payload, queuedAtMs: now });
      const oldest = this.#videoQueue[0];
      if (this.#videoQueue.length > MAX_QUEUED_VIDEO_PACKETS ||
        now - oldest.queuedAtMs > MAX_VIDEO_QUEUE_AGE_MS) {
        const dropped = this.#videoQueue.length;
        this.#videoQueue = [];
        this.#logger.trace('sctp flushed stale video queue to protect audio latency', {
          dropped
        });
      }
    }
    this.#pumpSendQueue();
  }

  handleDtlsPayload(plaintext) {
    if (this.#state === 'closed') return;
    let header;
    try {
      header = sctp.parsePacketHeader(plaintext);
    } catch (e) {

      this.#logger.trace('sctp payload failed to parse', {
        message: e.message, bytes: plaintext.length, hex: Buffer.from(plaintext).toString('hex')
      });
      return;
    }
    const chunkTypesForLog = sctp.splitChunks(plaintext, header.chunksStart).map((c) => c.type);
    this.#logger.trace('sctp recv packet', {
      vtag: `0x${header.verificationTag.toString(16)}`,
      expectVtag: `0x${this.#myTag.toString(16)}`,
      chunkTypes: chunkTypesForLog,
      state: this.#state
    });
    if (this.#state !== 'wait_init_ack' && header.verificationTag !== this.#myTag) {

      return;
    }
    const chunks = sctp.splitChunks(plaintext, header.chunksStart);
    for (const chunk of chunks) this.#handleChunk(chunk, header);
  }

  #sendInit() {
    const chunk = sctp.buildInit({
      initiateTag: this.#myTag,
      advertisedReceiverWindow: 131072,

      outboundStreams: 65535,
      inboundStreams: 65535,
      initialTsn: this.#initialTsn,
    });

    const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: 0, chunks: [chunk] });
    this.#logger.trace('sctp sending INIT', {
      myTag: `0x${this.#myTag.toString(16)}`, initialTsn: this.#initialTsn, attempt: this.#initRetries
    });
    if (this.#initRetries === 0) {

      this.#logger.trace('sctp INIT packet hex (first attempt only)', { hex: packet.toString('hex') });
    }
    this.#sendDtlsPayload(packet);
    clearTimeout(this.#retransmitTimer);
    this.#retransmitTimer = setTimeout(() => {
      if (this.#state !== 'wait_init_ack') return;
      this.#initRetries += 1;
      if (this.#initRetries > MAX_INIT_RETRIES) {
        this.#fail(new Error('SCTP: INIT retransmit limit exceeded'));
        return;
      }
      this.#sendInit();
    }, RETRANSMIT_TIMEOUT_MS * Math.min(2 ** this.#initRetries, 8));
  }

  #sendCookieEcho() {
    const chunk = sctp.buildCookieEcho(this.#stateCookie);
    const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [chunk] });
    this.#sendDtlsPayload(packet);
    clearTimeout(this.#retransmitTimer);
    this.#retransmitTimer = setTimeout(() => {
      if (this.#state !== 'wait_cookie_ack') return;
      this.#sendCookieEcho();
    }, RETRANSMIT_TIMEOUT_MS);
  }

  #onConnected() {
    this.#state = 'connected';
    clearTimeout(this.#retransmitTimer);
    this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.emit('connected');
    this.#pumpSendQueue();
  }

  #pumpSendQueue() {
    if (this.#state !== 'connected') return;
    while (this.#inFlight.size < SEND_WINDOW_SIZE) {
      let payload, isAudio;
      if (this.#audioQueue.length > 0) {
        payload = this.#audioQueue.shift();
        isAudio = true;
      } else if (this.#videoQueue.length > 0 && this.#videoInFlightCount < MAX_VIDEO_IN_FLIGHT) {
        payload = this.#videoQueue.shift().payload;
        isAudio = false;
      } else {
        break;
      }
      const tsn = this.#nextTsn;
      this.#nextTsn = (this.#nextTsn + 1) >>> 0;
      const streamSeq = isAudio ? this.#outboundStreamSeq++ : this.#outboundVideoStreamSeq++;
      const chunk = sctp.buildData({ tsn, streamId: 0, streamSeq, ppid: 53, payload, unordered: isAudio });
      const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [chunk] });
      const entry = { packet, timer: null, isAudio };
      this.#inFlight.set(tsn, entry);
      if (!isAudio) this.#videoInFlightCount++;
      this.#sendDtlsPayload(packet);
      this.#armDataRetransmit(tsn, entry);
    }
  }

  #retransmitCount = 0;

  #armDataRetransmit(tsn, entry) {
    clearTimeout(entry.timer);
    const timeoutMs = entry.isAudio ? RETRANSMIT_TIMEOUT_MS : VIDEO_RETRANSMIT_TIMEOUT_MS;
    entry.timer = setTimeout(() => {
      if (!this.#inFlight.has(tsn)) return;
      this.#retransmitCount++;
      this.#sendDtlsPayload(entry.packet);
      this.#armDataRetransmit(tsn, entry);
    }, timeoutMs);
  }

  #handleChunk(chunk, header) {
    switch (chunk.type) {
      case sctp.ChunkType.INIT_ACK: {
        if (this.#state !== 'wait_init_ack') return;
        const parsed = sctp.parseInitOrInitAck(chunk.value);
        if (!parsed.stateCookie) { this.#fail(new Error('SCTP: INIT ACK missing State Cookie')); return; }
        this.#peerVerificationTag = parsed.initiateTag;
        this.#peerInitialTsn = parsed.initialTsn;
        this.#inboundExpectedStreamSeq = 0;
        this.#inboundCumulativeTsn = (parsed.initialTsn - 1) >>> 0;
        this.#inboundReceivedAheadTsns.clear();
        this.#stateCookie = parsed.stateCookie;
        this.#state = 'wait_cookie_ack';
        this.#initRetries = 0;
        this.#sendCookieEcho();
        return;
      }
      case sctp.ChunkType.COOKIE_ACK: {
        if (this.#state !== 'wait_cookie_ack') return;
        this.#onConnected();
        return;
      }
      case sctp.ChunkType.DATA: {
        const parsed = sctp.parseData(chunk.flags, chunk.value);
        this.#handleIncomingData(parsed);
        return;
      }
      case sctp.ChunkType.SACK: {
        const parsed = sctp.parseSack(chunk.value);
        this.#handleSack(parsed);
        return;
      }
      case sctp.ChunkType.HEARTBEAT: {
        const info = sctp.parseHeartbeatInfo(chunk.value);
        const ackChunk = sctp.buildHeartbeatAck(info);
        const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [ackChunk] });
        this.#sendDtlsPayload(packet);
        return;
      }
      case sctp.ChunkType.HEARTBEAT_ACK:
        return;
      case sctp.ChunkType.ABORT:
        this.#fail(new Error('SCTP: received ABORT from peer'));
        return;
      case sctp.ChunkType.ERROR:

        return;
      default:
        return;
    }
  }

  #handleIncomingData({ tsn, streamId, streamSeq, ppid, payload, unordered }) {

    this.#recordInboundTsn(tsn);
    this.#buildAndSendSack();

    if (streamId !== 0 || ppid !== 53) return;

    if (unordered) {
      this.emit('message', payload);
      return;
    }

    if (streamSeq === this.#inboundExpectedStreamSeq) {
      this.#inboundExpectedStreamSeq += 1;
      this.emit('message', payload);

      while (this.#reorderBuffer.has(this.#inboundExpectedStreamSeq)) {
        const buffered = this.#reorderBuffer.get(this.#inboundExpectedStreamSeq);
        this.#reorderBuffer.delete(this.#inboundExpectedStreamSeq);
        this.#inboundExpectedStreamSeq += 1;
        this.emit('message', buffered);
      }
    } else if (streamSeq > this.#inboundExpectedStreamSeq) {
      this.#reorderBuffer.set(streamSeq, payload);
      if (this.#reorderBuffer.size > STALE_GAP_TSN_LIMIT) {
        const bufferedSeqs = [...this.#reorderBuffer.keys()].sort((a, b) => a - b);
        this.#logger.debug('sctp: forcing stream sequence past a stuck gap', {
          from: this.#inboundExpectedStreamSeq, bufferedCount: bufferedSeqs.length
        });
        this.#inboundExpectedStreamSeq = bufferedSeqs[0];
        const buffered = this.#reorderBuffer.get(this.#inboundExpectedStreamSeq);
        this.#reorderBuffer.delete(this.#inboundExpectedStreamSeq);
        this.#inboundExpectedStreamSeq += 1;
        this.emit('message', buffered);
        while (this.#reorderBuffer.has(this.#inboundExpectedStreamSeq)) {
          const next = this.#reorderBuffer.get(this.#inboundExpectedStreamSeq);
          this.#reorderBuffer.delete(this.#inboundExpectedStreamSeq);
          this.#inboundExpectedStreamSeq += 1;
          this.emit('message', next);
        }
      }
    }

  }

  #recordInboundTsn(tsn) {
    if (sackAcksTsn(this.#inboundCumulativeTsn, tsn)) {
      return;
    }
    this.#inboundReceivedAheadTsns.add(tsn);
    let next = (this.#inboundCumulativeTsn + 1) >>> 0;
    while (this.#inboundReceivedAheadTsns.has(next)) {
      this.#inboundReceivedAheadTsns.delete(next);
      this.#inboundCumulativeTsn = next;
      next = (this.#inboundCumulativeTsn + 1) >>> 0;
    }
    if (this.#inboundReceivedAheadTsns.size > STALE_GAP_TSN_LIMIT) {
      let maxAheadOffset = 0;
      for (const aheadTsn of this.#inboundReceivedAheadTsns) {
        const offset = (aheadTsn - this.#inboundCumulativeTsn) >>> 0;
        if (offset > maxAheadOffset) maxAheadOffset = offset;
      }
      const jumpTo = (this.#inboundCumulativeTsn + maxAheadOffset) >>> 0;
      this.#logger.debug('sctp: forcing cumulative TSN past a stuck gap', {
        from: this.#inboundCumulativeTsn, to: jumpTo, aheadCount: this.#inboundReceivedAheadTsns.size
      });
      this.#inboundReceivedAheadTsns.delete(jumpTo);
      this.#inboundCumulativeTsn = jumpTo;
    }
  }

  #buildAndSendSack() {
    const gapAckBlocks = [];
    if (this.#inboundReceivedAheadTsns.size > 0) {
      const sorted = [...this.#inboundReceivedAheadTsns].sort((a, b) => {
        const diffA = (a - this.#inboundCumulativeTsn) >>> 0;
        const diffB = (b - this.#inboundCumulativeTsn) >>> 0;
        return diffA - diffB;
      });
      let blockStart = null;
      let blockEnd = null;
      for (const tsn of sorted) {
        const offset = (tsn - this.#inboundCumulativeTsn) >>> 0;
        if (offset > 0xffff) continue;
        if (blockStart !== null && offset === blockEnd + 1) {
          blockEnd = offset;
        } else {
          if (blockStart !== null) gapAckBlocks.push({ start: blockStart, end: blockEnd });
          blockStart = offset;
          blockEnd = offset;
        }
      }
      if (blockStart !== null) gapAckBlocks.push({ start: blockStart, end: blockEnd });
    }
    const sackChunk = sctp.buildSack({
      cumulativeTsnAck: this.#inboundCumulativeTsn,
      advertisedReceiverWindow: 131072,
      gapAckBlocks
    });
    const sackPacket = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [sackChunk] });
    this.#sendDtlsPayload(sackPacket);
  }

  #handleSack({ cumulativeTsnAck, gapAckBlocks }) {
    if (this.#inFlight.size === 0) return;
    let acked = false;
    for (const [tsn, entry] of this.#inFlight) {
      if (sackAcksTsn(cumulativeTsnAck, tsn)) {
        clearTimeout(entry.timer);
        this.#inFlight.delete(tsn);
        if (!entry.isAudio) this.#videoInFlightCount--;
        acked = true;
      }
    }
    if (gapAckBlocks && gapAckBlocks.length > 0 && this.#inFlight.size > 0) {
      for (const block of gapAckBlocks) {
        for (const [tsn, entry] of this.#inFlight) {
          const offset = (tsn - cumulativeTsnAck) >>> 0;
          if (offset >= block.start && offset <= block.end) {
            clearTimeout(entry.timer);
            this.#inFlight.delete(tsn);
            if (!entry.isAudio) this.#videoInFlightCount--;
            acked = true;
          }
        }
      }
    }
    if (acked) this.#pumpSendQueue();
  }

  #sendHeartbeat() {
    if (this.#state !== 'connected') return;
    const info = randomBytes(16);
    const chunk = sctp.buildHeartbeat(info);
    const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [chunk] });
    this.#sendDtlsPayload(packet);
  }

  #fail(err) {
    this.#state = 'closed';
    clearTimeout(this.#retransmitTimer);
    clearInterval(this.#heartbeatTimer);
    for (const entry of this.#inFlight.values()) clearTimeout(entry.timer);
    this.#inFlight.clear();
    this.#videoInFlightCount = 0;
    this.#audioQueue = [];
    this.#videoQueue = [];
    this.#reorderBuffer.clear();
    this.#inboundReceivedAheadTsns.clear();
    this.emit('error', err);
  }
}

function sackAcksTsn(cumAck, tsn) {
  const diff = (cumAck - tsn) >>> 0;
  return diff < 0x80000000;
}
