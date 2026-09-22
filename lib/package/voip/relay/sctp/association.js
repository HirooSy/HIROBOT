import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../../shim/core.js';
import * as sctp from './wire.js';

const SCTP_PORT = 5000;
const RETRANSMIT_TIMEOUT_MS = 1000;
const MAX_INIT_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 5000;

const SEND_WINDOW_SIZE = 32;
// Audio and video RTP share this one reliable/ordered SCTP association, but
// they don't share the same real-time tolerance: a stalled/late audio frame
// is heard as dead air almost immediately, while video can absorb some loss
// (it already recovers via IDR frames). Without prioritization, a burst of
// video packets fills the single FIFO ahead of audio and delays it well past
// what a jitter buffer will accept - audio gets "sent" but arrives too late
// to be heard. To fix this without touching the wire protocol: audio always
// drains first (see #pumpSendQueue).
//
// Video is only dropped once it's been sitting long enough to be stale -
// not just because a handful of packets piled up, which is normal (a single
// H.264 access unit is several packets, and audio is drained first anyway
// so a short video queue costs it nothing). Dropping too eagerly cuts
// access units mid-frame, which is what causes visible stutter/freeze-then-
// jump on the receiving side - worse than the original delay bug.
const MAX_VIDEO_QUEUE_AGE_MS = 400;
const MAX_QUEUED_VIDEO_PACKETS = 200;
// Draining audio first only helps if video can't then claim the entire
// shared in-flight window the moment it's free - video has a much larger,
// always-ready backlog than audio (which only produces one small frame
// every 60ms), so without a cap here video ends up occupying nearly all of
// SEND_WINDOW_SIZE continuously. That starves audio's own retransmit/RTT
// budget even though it's queued first, and shows up as overall connection
// degradation (WhatsApp's network-quality indicator, visible stutter).
// Reserving headroom keeps room for audio's next frame(s) to always get an
// in-flight slot immediately instead of competing with a full video window.
const MAX_VIDEO_IN_FLIGHT = 8;

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
  #inboundExpectedStreamSeq = 0;
  #reorderBuffer = new Map();
  #inFlight = new Map();
  #videoInFlightCount = 0;
  #audioQueue = [];
  #videoQueue = [];

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
  }

  get isConnected() { return this.#state === 'connected'; }

  getSendBacklog() {
    return {
      queued: this.#audioQueue.length + this.#videoQueue.length,
      queuedAudio: this.#audioQueue.length,
      queuedVideo: this.#videoQueue.length,
      inFlight: this.#inFlight.size
    };
  }

  // isAudio lets us drain audio ahead of video below - see the comment on
  // MAX_VIDEO_QUEUE_AGE_MS for why. Payloads with isAudio left undefined
  // (e.g. non-media control data) are treated as high priority, same as audio.
  send(payload, isAudio = true) {
    if (this.#state === 'closed') return;
    if (isAudio) {
      this.#audioQueue.push(payload);
    } else {
      const now = Date.now();
      this.#videoQueue.push({ payload, queuedAtMs: now });
      // If the queue is stale or oversized, drop it entirely rather than
      // trimming packet-by-packet - a partial drop can split a single H.264
      // access unit across the cut, which the decoder can't recover from
      // until the next keyframe (the stutter-then-jump behavior). Video
      // already resends a keyframe at least twice a second (see
      // WaVideoEngine's keyint), so a full flush here just means a brief
      // gap until the next one, not a broken decode.
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
      const streamSeq = this.#outboundStreamSeq;
      this.#outboundStreamSeq += 1;
      // WhatsApp's web-call data channel is unordered (mirrors the browser
      // client's RTCDataChannel({ ordered: false })) - media is real-time,
      // so a chunk that arrives late is worthless and must never block
      // chunks behind it. Sending these as ordered (the wire.js default)
      // meant the peer's own reassembly would only ever deliver DATA in
      // strict TSN sequence, so a single dropped chunk anywhere in the call
      // wedged its entire inbound stream behind it forever - see the
      // matching receive-side comment in #handleIncomingData for the other
      // half of this.
      const chunk = sctp.buildData({ tsn, streamId: 0, streamSeq, ppid: 53, payload, unordered: true });
      const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [chunk] });
      const entry = { packet, timer: null, isAudio };
      this.#inFlight.set(tsn, entry);
      if (!isAudio) this.#videoInFlightCount++;
      this.#sendDtlsPayload(packet);
      this.#armDataRetransmit(tsn, entry);
    }
  }


  #armDataRetransmit(tsn, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.#inFlight.has(tsn)) return;
      this.#sendDtlsPayload(entry.packet);
      this.#armDataRetransmit(tsn, entry);
    }, RETRANSMIT_TIMEOUT_MS);
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

    const sackChunk = sctp.buildSack({ cumulativeTsnAck: tsn, advertisedReceiverWindow: 131072 });
    const sackPacket = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [sackChunk] });
    this.#sendDtlsPayload(sackPacket);

    if (streamId !== 0 || ppid !== 53) return;

    // Unordered chunks (see #pumpSendQueue for why WhatsApp media uses
    // this) must be delivered the instant they arrive, independent of any
    // other chunk's stream sequence number - that's the entire point of
    // unordered delivery per RFC 4960 Sec 3.3.1. Every chunk this
    // association ever builds is a complete, unfragmented message (buildData
    // always defaults beginning=true, ending=true - see wire.js), so there is
    // no reassembly to do here: emit it immediately. Previously this branch
    // didn't exist, so unordered chunks fell through to the ordered path
    // below and got held in #reorderBuffer waiting for a streamSeq that
    // would only ever arrive by the sender re-sending it - which real-time
    // media never does - so a single dropped/reordered packet anywhere in
    // the call silently wedged every chunk after it, forever.
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
    }

  }

  #handleSack({ cumulativeTsnAck }) {
    if (this.#inFlight.size === 0) return;
    let acked = false;
    for (const [tsn, entry] of this.#inFlight) {
      // TSNs are 32-bit and wrap around, so this must always go through the
      // wraparound-safe comparator - a plain `cumulativeTsnAck >= tsn` is
      // only correct until the first wrap (roughly every ~4 billion DATA
      // chunks, i.e. eventually on any long-running call) and then starts
      // flagging arbitrary unacked TSNs as acked (or the reverse), which
      // either drops packets the peer never actually got or leaves acked
      // ones stuck retransmitting forever.
      if (sackAcksTsn(cumulativeTsnAck, tsn)) {
        clearTimeout(entry.timer);
        this.#inFlight.delete(tsn);
        if (!entry.isAudio) this.#videoInFlightCount--;
        acked = true;
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
    this.emit('error', err);
  }
}

function sackAcksTsn(cumAck, tsn) {
  const diff = (cumAck - tsn) >>> 0;
  return diff < 0x80000000;
}
