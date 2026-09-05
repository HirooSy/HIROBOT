import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../../shim/core.js';
import * as sctp from './wire.js';

// SCTP association client (RFC 4960), scoped to exactly what a pre-negotiated
// WebRTC DataChannel needs: one association, one bidirectional stream
// (id=0, per RFC 8831 "client picks even stream identifiers" and
// meowcaller's Go reference using datachannel.Dial(assoc, 0, ...)), reliable
// ordered delivery, no multi-homing. Runs entirely over an already-connected
// DtlsClient (dtls/handshake.js) — every SCTP packet we build/parse here is
// itself the plaintext payload of one DTLS application_data record; this
// module never touches sockets directly (per RFC 8261, "DTLS Encapsulation
// of SCTP Packets": SCTP packets ARE the DTLS user_data).
//
// Flow:
//   -> INIT
//   <- INIT ACK (with State Cookie)
//   -> COOKIE ECHO
//   <- COOKIE ACK                    [association established]
//   -> DATA(tsn=initialTsn, ...) / <- SACK, repeat
//   <- HEARTBEAT -> HEARTBEAT ACK (relay-initiated liveness probes)

const SCTP_PORT = 5000; // WebRTC convention (RFC 8841 example: a=sctp-port:5000) -- not a real transport-layer port, just this field's conventional value when SCTP rides on DTLS
const RETRANSMIT_TIMEOUT_MS = 1000;
const MAX_INIT_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 5000; // we also send our own, defensively, in case the relay expects the client to initiate
// Fixed-size sliding window for DATA chunks in flight post-handshake (see
// #pumpSendQueue's comment). 32 chunks at ~60ms audio-frame cadence and a
// relay RTT well under a second (same relay this project already does a
// DTLS+STUN round trip against) comfortably covers a live call's outbound
// rate without ever needing real congestion control.
const SEND_WINDOW_SIZE = 32;

function randomUint32() {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * @param {{ sendDtlsPayload: (plaintext: Buffer) => void }} params - caller
 *   supplies a function that encrypts+sends one SCTP packet via the
 *   already-connected DtlsClient (dtls/handshake.js's encryptApplicationData
 *   + the UDP socket send, composed by relay-transport.js).
 * Emits: 'connected', 'message' (Buffer, the payload of one received DATA
 *   chunk with PPID 53/WebRTC Binary — other PPIDs are ignored), 'error'
 */
export class SctpAssociation extends EventEmitter {
  #sendDtlsPayload;
  #logger;
  #state = 'idle'; // idle -> wait_init_ack -> wait_cookie_ack -> connected -> closed
  // A single tag identifies us to the peer for the life of the association
  // (RFC 4960 §5.1): it's what we put in our own INIT's initiateTag field,
  // and it's the value the peer must echo back as the header verification
  // tag on every subsequent packet it sends us. These were previously two
  // separately-randomized fields (#myVerificationTag and #myInitiateTag)
  // that coincidentally almost never matched each other — the peer
  // correctly echoed initiateTag as the header vtag exactly per spec, but
  // our own incoming-packet check validated against the OTHER random value,
  // so every post-INIT packet from the peer (INIT ACK's own header is
  // exempted, but everything after — critically COOKIE_ACK — is not) was
  // silently dropped forever. Caught by the SCTP integration test: the
  // client saw COOKIE_ACK arrive (same bytes reached handleDtlsPayload) but
  // never transitioned to 'connected'.
  #myTag = randomUint32();
  #peerVerificationTag = 0;
  #initialTsn = randomUint32();
  #nextTsn;
  #peerInitialTsn = 0;
  #cumulativeAckReceived = -1; // last TSN the peer has SACK'd, as a signed tracking value (-1 = none yet)
  #stateCookie = null;
  #retransmitTimer = null;
  #initRetries = 0;
  #heartbeatTimer = null;
  #outboundStreamSeq = 0;
  #inboundExpectedStreamSeq = 0; // for ordered delivery on stream 0
  #reorderBuffer = new Map(); // streamSeq -> payload, for out-of-order ordered-stream DATA
  #inFlight = new Map(); // tsn -> { packet, timer } — bounded sliding window, see #pumpSendQueue
  #sendQueue = [];

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
  }

  get isConnected() { return this.#state === 'connected'; }

  /** Number of application messages queued but not yet handed to
   * #pumpSendQueue (i.e. waiting for window space), plus how many are
   * currently in flight awaiting SACK. Exposed purely for diagnostics —
   * a real-world signal for whether outbound pacing is actually
   * bottlenecked here, instead of inferring it from wall-clock gaps
   * measured one layer up. */
  getSendBacklog() {
    return { queued: this.#sendQueue.length, inFlight: this.#inFlight.size };
  }

  /** Queues one application message (already PPID-tagged by the caller's
   * choice, but we hardcode WebRTC Binary=53 here since that's the only
   * PPID our relay-transport ever needs — see relay-transport.js, which
   * only ever pushes opaque binary STUN/RTP payloads through this channel).
   * RFC 8831 forbids more than one application message per SCTP user
   * message, so each call here is exactly one DATA chunk. */
  send(payload) {
    if (this.#state === 'closed') return;
    this.#sendQueue.push(payload);
    this.#pumpSendQueue();
  }

  /** Feed one decrypted DTLS application_data payload in (i.e. one SCTP packet's plaintext bytes). */
  handleDtlsPayload(plaintext) {
    if (this.#state === 'closed') return;
    let header;
    try {
      header = sctp.parsePacketHeader(plaintext);
    } catch (e) {
      // Was a bare console.log — if the relay's SCTP replies fail our
      // checksum/framing check, this was previously a silent drop; surface
      // it so "relay never sent anything back" and "relay sent something we
      // can't parse" are distinguishable, same reasoning as the DTLS-layer log.
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
      // RFC 4960 §8.5: verification tag must match our own tag on every
      // packet once we've told the peer what it is (INIT/INIT ACK are the
      // exceptions, carrying 0 / the peer's tag respectively, per spec).
      return;
    }
    const chunks = sctp.splitChunks(plaintext, header.chunksStart);
    for (const chunk of chunks) this.#handleChunk(chunk, header);
  }

  // ---- handshake ----

  #sendInit() {
    const chunk = sctp.buildInit({
      initiateTag: this.#myTag,
      advertisedReceiverWindow: 131072,
      // WebRTC convention (not an SCTP core requirement) is to always
      // advertise the max 65535 streams in both directions, even though a
      // pre-negotiated single-stream DataChannel only ever uses stream 0 —
      // see pion-webrtc's sctptransport.go (`sctpMaxChannels = uint16(65535)`)
      // and multiple other SCTP-for-WebRTC implementations doing the same.
      // Previously sent 1/1 here, which is valid per bare RFC 4960 and
      // which our own Python test server (also written from scratch)
      // silently accepted without complaint — but a real WhatsApp relay,
      // built to the WebRTC-flavored expectations, may be quietly
      // discarding an INIT that doesn't look like a real WebRTC peer's.
      outboundStreams: 65535,
      inboundStreams: 65535,
      initialTsn: this.#initialTsn,
    });
    // RFC 4960 §5.1: a packet carrying INIT MUST have verification tag 0.
    const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: 0, chunks: [chunk] });
    this.#logger.trace('sctp sending INIT', {
      myTag: `0x${this.#myTag.toString(16)}`, initialTsn: this.#initialTsn, attempt: this.#initRetries
    });
    if (this.#initRetries === 0) {
      // Raw plaintext bytes of the first INIT packet (pre-DTLS-encryption),
      // for byte-for-byte comparison against a known-good WebRTC SCTP INIT if
      // the relay ever stops ACKing it again — everything up to this point
      // (DTLS handshake, encryption) is independently verifiable via the
      // server Finished decrypting successfully, so if there's ever a
      // silent-drop bug again, this is the most likely remaining place: the
      // SCTP wire format itself, not the transport carrying it.
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

  // ---- data transfer ----
  // Deliberately simple: at most one DATA chunk in flight at a time
  // (stop-and-wait, not a sliding window). WebRTC DataChannel traffic here
  // is STUN/RTP-sized signaling+keepalive packets at a modest rate (see
  // engine.js/relay-transport.js callers), not bulk transfer, so the
  // throughput cost of stop-and-wait is not a real concern, and it avoids
  // an entire class of window-management/congestion-control bugs that a
  // full sliding-window implementation would risk introducing.

  // Bounded sliding window (fixed size, no cwnd/ssthresh growth): up to
  // SEND_WINDOW_SIZE DATA chunks in flight at once, each with its own
  // retransmit timer, instead of stop-and-wait (one chunk, full RTT,
  // repeat). This is not a real RFC 4960 congestion controller — no
  // slow-start, no congestion avoidance, no rwnd tracking — just enough
  // to stop 60ms-cadence RTP frames from queueing behind each other's
  // round trip to the relay one at a time.
  //
  // FOUND A BUG: this used to allow only one chunk in flight (#unacknowledgedData,
  // singular) with a 1000ms retransmit timeout, and the comment justifying
  // it ("WebRTC DataChannel traffic here is STUN/RTP-sized signaling+
  // keepalive packets at a modest rate ... not bulk transfer") was true for
  // signaling but not for the actual RTP media once a call is live: audio
  // frames are generated every 60ms (WaAudioEngine's captureInterval) and
  // pushed straight into send() one at a time. Under stop-and-wait, every
  // single one of those had to wait for a full relay round-trip (or worse,
  // the 1s retransmit timer) before the next could go out — with any real
  // RTT, that alone throttles audio to nowhere near real-time pacing,
  // independent of anything about the opus/mlow codec itself. A real SCTP
  // peer (pion/sctp, which the relay is built on — see relay.go's
  // sctp.ClientWithOptions) always allows a full congestion window of
  // chunks in flight; stop-and-wait was never going to match its expected
  // send rate.
  #pumpSendQueue() {
    if (this.#state !== 'connected') return;
    while (this.#inFlight.size < SEND_WINDOW_SIZE && this.#sendQueue.length > 0) {
      const payload = this.#sendQueue.shift();
      const tsn = this.#nextTsn;
      this.#nextTsn = (this.#nextTsn + 1) >>> 0;
      const streamSeq = this.#outboundStreamSeq;
      this.#outboundStreamSeq += 1;
      const chunk = sctp.buildData({ tsn, streamId: 0, streamSeq, ppid: 53 /* WebRTC Binary, RFC 8831 §8 */, payload });
      const packet = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [chunk] });
      const entry = { packet, timer: null };
      this.#inFlight.set(tsn, entry);
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
        return; // liveness confirmed; nothing to act on beyond that for our purposes
      case sctp.ChunkType.ABORT:
        this.#fail(new Error('SCTP: received ABORT from peer'));
        return;
      case sctp.ChunkType.ERROR:
        // Non-fatal per RFC 4960 unless it precedes an ABORT; log via error
        // event but don't tear down, mirroring how a real stack keeps going.
        return;
      default:
        return;
    }
  }

  #handleIncomingData({ tsn, streamId, streamSeq, ppid, payload }) {
    // Always SACK the highest cumulative TSN we've contiguously received,
    // regardless of stream/ordering state below — the peer needs this to
    // clear its retransmit timer even if delivery to the application is
    // deferred for reordering.
    const sackChunk = sctp.buildSack({ cumulativeTsnAck: tsn, advertisedReceiverWindow: 131072 });
    const sackPacket = sctp.buildPacket({ sourcePort: SCTP_PORT, destinationPort: SCTP_PORT, verificationTag: this.#peerVerificationTag, chunks: [sackChunk] });
    this.#sendDtlsPayload(sackPacket);

    if (streamId !== 0 || ppid !== 53) return; // only stream 0 / WebRTC Binary is meaningful to relay-transport.js's caller

    if (streamSeq === this.#inboundExpectedStreamSeq) {
      this.#inboundExpectedStreamSeq += 1;
      this.emit('message', payload);
      // Drain any buffered out-of-order messages that are now next-in-line.
      while (this.#reorderBuffer.has(this.#inboundExpectedStreamSeq)) {
        const buffered = this.#reorderBuffer.get(this.#inboundExpectedStreamSeq);
        this.#reorderBuffer.delete(this.#inboundExpectedStreamSeq);
        this.#inboundExpectedStreamSeq += 1;
        this.emit('message', buffered);
      }
    } else if (streamSeq > this.#inboundExpectedStreamSeq) {
      this.#reorderBuffer.set(streamSeq, payload); // hold for in-order delivery
    }
    // streamSeq < expected: duplicate/old, already delivered — drop silently.
  }

  #handleSack({ cumulativeTsnAck }) {
    if (this.#inFlight.size === 0) return;
    let acked = false;
    for (const [tsn, entry] of this.#inFlight) {
      if (cumulativeTsnAck >= tsn >>> 0 || sackAcksTsn(cumulativeTsnAck, tsn)) {
        clearTimeout(entry.timer);
        this.#inFlight.delete(tsn);
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
    this.emit('error', err);
  }
}

/** TSN comparison per RFC 4960 §1.6 (serial number arithmetic, RFC 1982
 * style, since TSN wraps at 2^32): true if `cumAck` acknowledges `tsn`,
 * accounting for wraparound. Used alongside the simple >= check above,
 * which is correct except right at the wrap boundary. */
function sackAcksTsn(cumAck, tsn) {
  const diff = (cumAck - tsn) >>> 0;
  return diff < 0x80000000; // cumAck is "at or after" tsn in circular order
}
