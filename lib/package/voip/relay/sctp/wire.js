import { crc32c } from './crc32c.js';

// SCTP packet/chunk wire format (RFC 4960 §3). We implement only what a
// pre-negotiated WebRTC DataChannel needs: INIT/INIT_ACK/COOKIE_ECHO/
// COOKIE_ACK for association setup, DATA/SACK for the one reliable ordered
// stream the pre-negotiated channel uses, HEARTBEAT/HEARTBEAT_ACK (relays
// may probe liveness), and ABORT for teardown/errors. No multi-homing, no
// partial reliability extension, no SCTP-AUTH — none of that is needed for
// a single pre-negotiated stream to one fixed relay address.

export const ChunkType = Object.freeze({
  DATA: 0,
  INIT: 1,
  INIT_ACK: 2,
  SACK: 3,
  HEARTBEAT: 4,
  HEARTBEAT_ACK: 5,
  ABORT: 6,
  SHUTDOWN: 7,
  SHUTDOWN_ACK: 8,
  ERROR: 9,
  COOKIE_ECHO: 10,
  COOKIE_ACK: 11,
  SHUTDOWN_COMPLETE: 14,
});

const COMMON_HEADER_LEN = 12; // srcPort(2) dstPort(2) verificationTag(4) checksum(4)

function pad4(len) { return (4 - (len % 4)) % 4; }

/**
 * Builds one full SCTP packet: common header + one or more already-encoded
 * chunks, with the CRC32C checksum computed and inserted (RFC 4960 §6.8:
 * checksum is computed over the whole packet with the checksum field itself
 * treated as zero).
 */
export function buildPacket({ sourcePort, destinationPort, verificationTag, chunks }) {
  const header = Buffer.alloc(COMMON_HEADER_LEN);
  header.writeUInt16BE(sourcePort, 0);
  header.writeUInt16BE(destinationPort, 2);
  header.writeUInt32BE(verificationTag >>> 0, 4);
  // checksum field (bytes 8-11) left zero for the CRC computation pass
  const body = Buffer.concat(chunks);
  const packetWithZeroChecksum = Buffer.concat([header, body]);
  const checksum = crc32c(packetWithZeroChecksum);
  // FOUND A BUG: this used to be writeUInt32BE. Every other field in this
  // header is big-endian (network byte order) per RFC 4960, and it's
  // tempting to assume the checksum is too — but it isn't. Our crc32c()
  // above is the standard table-driven CRC-32C, which (like every common
  // CRC32 implementation, including Go's hash/crc32) computes with a
  // *reflected* polynomial/input/output. Per pion/sctp's packet.go
  // (marshal(), see its own comment on this exact line): "golang CRC32C
  // uses reflected input and reflected output, the net result of this is
  // to have the bytes flipped compared to the non reflected variant that
  // the spec expects. Use LittleEndian.PutUint32 to avoid flipping the
  // bytes into the spec compliant checksum order." Writing this field
  // big-endian, as before, put the checksum bytes in reverse order from
  // what a real SCTP peer computes and expects — every packet we sent
  // failed checksum validation and was silently dropped, which is exactly
  // why INIT retransmitted forever (attempts 0-4, all relays) with the
  // DTLS layer underneath completely unaffected (it doesn't touch this
  // field at all) and no error of any kind, ever, on either side.
  packetWithZeroChecksum.writeUInt32LE(checksum, 8);
  return packetWithZeroChecksum;
}

/** Parses the common header and validates the checksum. Throws on checksum mismatch or truncation — a corrupt SCTP packet on an unreliable transport should be dropped, not half-processed. */
export function parsePacketHeader(datagram) {
  if (datagram.length < COMMON_HEADER_LEN) throw new Error('SCTP packet shorter than common header');
  const sourcePort = datagram.readUInt16BE(0);
  const destinationPort = datagram.readUInt16BE(2);
  const verificationTag = datagram.readUInt32BE(4) >>> 0;
  // Same fix as buildPacket's write — see its comment. This field alone is
  // little-endian on the wire; everything else in this header is BE.
  const receivedChecksum = datagram.readUInt32LE(8) >>> 0;
  const forVerification = Buffer.from(datagram);
  forVerification.writeUInt32BE(0, 8);
  const computedChecksum = crc32c(forVerification);
  if (computedChecksum !== receivedChecksum) {
    throw new Error(`SCTP checksum mismatch: got 0x${receivedChecksum.toString(16)}, computed 0x${computedChecksum.toString(16)}`);
  }
  return { sourcePort, destinationPort, verificationTag, chunksStart: COMMON_HEADER_LEN };
}

/** Splits the chunk area of a packet (after the 12-byte common header) into
 * individual raw chunk buffers (header + value, no padding). Each chunk is
 * 4-byte padded on the wire; padding is stripped here since length is
 * authoritative. */
export function splitChunks(datagram, chunksStart) {
  const chunks = [];
  let offset = chunksStart;
  while (offset + 4 <= datagram.length) {
    const type = datagram.readUInt8(offset);
    const flags = datagram.readUInt8(offset + 1);
    const length = datagram.readUInt16BE(offset + 2); // includes the 4-byte chunk header itself
    if (length < 4 || offset + length > datagram.length) break; // malformed trailing data
    chunks.push({ type, flags, value: datagram.subarray(offset + 4, offset + length) });
    offset += length + pad4(length);
  }
  return chunks;
}

/** Encodes one chunk (type+flags+value), 4-byte padded per RFC 4960 §3.2. */
export function encodeChunk(type, flags, value) {
  const length = 4 + value.length;
  const header = Buffer.alloc(4);
  header.writeUInt8(type, 0);
  header.writeUInt8(flags, 1);
  header.writeUInt16BE(length, 2);
  const padding = Buffer.alloc(pad4(length));
  return Buffer.concat([header, value, padding]);
}

// ---- INIT / INIT ACK ----

// RFC 5061 §4.2.7 "Supported Extensions Parameter": declares which optional
// chunk types this endpoint understands. Every real-world WebRTC SCTP stack
// sends this in its INIT — Chrome/Firefox's usrsctp, and (concretely, since
// it's meowcaller's own dependency and confirmed working against this exact
// relay) pion/sctp, which always appends `{ChunkTypes: [ctReconfig,
// ctForwardTSN]}` to every INIT it builds (pion/sctp's association.go:
// setSupportedExtensions). Previously we sent zero optional parameters at
// all — valid per bare RFC 4960 (all of this is optional), but a relay that
// has only ever been exercised against genuine WebRTC-flavored clients may
// not treat a parameter-less INIT as one of those and silently drop it,
// which matches exactly what was observed: DTLS completes, INIT retransmits
// forever, never an INIT ACK. Matching pion's exact parameter set here costs
// nothing and removes this as a variable.
const SUPPORTED_EXTENSIONS_PARAM_TYPE = 0x8008;
const CHUNK_TYPE_RECONFIG = 130; // RFC 6525
const CHUNK_TYPE_FORWARD_TSN = 192; // RFC 3758

function buildSupportedExtensionsParam() {
  const chunkTypes = Buffer.from([CHUNK_TYPE_RECONFIG, CHUNK_TYPE_FORWARD_TSN]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(SUPPORTED_EXTENSIONS_PARAM_TYPE, 0);
  header.writeUInt16BE(4 + chunkTypes.length, 2);
  return Buffer.concat([header, chunkTypes, Buffer.alloc(pad4(4 + chunkTypes.length))]);
}

/** INIT/INIT ACK fixed parameters (RFC 4960 §3.3.2/§3.3.3): initiateTag(4)
 * a_rwnd(4) numOutboundStreams(2) numInboundStreams(2) initialTSN(4), plus
 * the Supported Extensions Parameter above (we still don't emit address
 * lists or negotiate zero-checksum — single-homed, and our own parser always
 * requires a real CRC32c, which is the RFC 4960 default). */
export function buildInit({ initiateTag, advertisedReceiverWindow, outboundStreams, inboundStreams, initialTsn }) {
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32BE(initiateTag >>> 0, 0);
  fixed.writeUInt32BE(advertisedReceiverWindow >>> 0, 4);
  fixed.writeUInt16BE(outboundStreams, 8);
  fixed.writeUInt16BE(inboundStreams, 10);
  fixed.writeUInt32BE(initialTsn >>> 0, 12);
  const value = Buffer.concat([fixed, buildSupportedExtensionsParam()]);
  return encodeChunk(ChunkType.INIT, 0, value);
}

export function parseInitOrInitAck(chunkValue) {
  const initiateTag = chunkValue.readUInt32BE(0) >>> 0;
  const advertisedReceiverWindow = chunkValue.readUInt32BE(4) >>> 0;
  const outboundStreams = chunkValue.readUInt16BE(8);
  const inboundStreams = chunkValue.readUInt16BE(10);
  const initialTsn = chunkValue.readUInt32BE(12) >>> 0;
  // Parse TLV parameters starting at offset 16; we only look for State
  // Cookie (type 7) since that's the only one COOKIE_ECHO needs to echo back.
  let offset = 16;
  let stateCookie = null;
  while (offset + 4 <= chunkValue.length) {
    const paramType = chunkValue.readUInt16BE(offset);
    const paramLength = chunkValue.readUInt16BE(offset + 2); // includes 4-byte param header
    if (paramLength < 4 || offset + paramLength > chunkValue.length) break;
    const paramValue = chunkValue.subarray(offset + 4, offset + paramLength);
    if (paramType === 7) stateCookie = paramValue; // State Cookie
    offset += paramLength + pad4(paramLength);
  }
  return { initiateTag, advertisedReceiverWindow, outboundStreams, inboundStreams, initialTsn, stateCookie };
}

export function buildInitAck({ initiateTag, advertisedReceiverWindow, outboundStreams, inboundStreams, initialTsn, stateCookie }) {
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32BE(initiateTag >>> 0, 0);
  fixed.writeUInt32BE(advertisedReceiverWindow >>> 0, 4);
  fixed.writeUInt16BE(outboundStreams, 8);
  fixed.writeUInt16BE(inboundStreams, 10);
  fixed.writeUInt32BE(initialTsn >>> 0, 12);
  const cookieParamHeader = Buffer.alloc(4);
  cookieParamHeader.writeUInt16BE(7, 0); // State Cookie parameter type
  cookieParamHeader.writeUInt16BE(4 + stateCookie.length, 2);
  const cookieParam = Buffer.concat([cookieParamHeader, stateCookie, Buffer.alloc(pad4(4 + stateCookie.length))]);
  return encodeChunk(ChunkType.INIT_ACK, 0, Buffer.concat([fixed, cookieParam]));
}

export function buildCookieEcho(stateCookie) {
  return encodeChunk(ChunkType.COOKIE_ECHO, 0, stateCookie);
}

export function buildCookieAck() {
  return encodeChunk(ChunkType.COOKIE_ACK, 0, Buffer.alloc(0));
}

// ---- DATA / SACK ----

const DATA_HEADER_LEN = 12; // TSN(4) streamId(2) streamSeq(2) PPID(4)

/** @param {{ tsn: number, streamId: number, streamSeq: number, ppid: number, payload: Buffer, unordered?: boolean, beginning?: boolean, ending?: boolean }} params
 * beginning/ending default true (single-fragment message — RFC 8831 requires
 * exactly one SCTP user message per application message, so we never
 * fragment at the SCTP layer ourselves). */
export function buildData({ tsn, streamId, streamSeq, ppid, payload, unordered = false, beginning = true, ending = true }) {
  let flags = 0;
  if (unordered) flags |= 0x04; // U bit
  if (beginning) flags |= 0x02; // B bit
  if (ending) flags |= 0x01; // E bit
  const value = Buffer.alloc(DATA_HEADER_LEN + payload.length);
  value.writeUInt32BE(tsn >>> 0, 0);
  value.writeUInt16BE(streamId, 4);
  value.writeUInt16BE(streamSeq, 6);
  value.writeUInt32BE(ppid >>> 0, 8);
  payload.copy(value, DATA_HEADER_LEN);
  return encodeChunk(ChunkType.DATA, flags, value);
}

export function parseData(chunkFlags, chunkValue) {
  return {
    unordered: (chunkFlags & 0x04) !== 0,
    beginning: (chunkFlags & 0x02) !== 0,
    ending: (chunkFlags & 0x01) !== 0,
    tsn: chunkValue.readUInt32BE(0) >>> 0,
    streamId: chunkValue.readUInt16BE(4),
    streamSeq: chunkValue.readUInt16BE(6),
    ppid: chunkValue.readUInt32BE(8) >>> 0,
    payload: chunkValue.subarray(DATA_HEADER_LEN),
  };
}

/** SACK (RFC 4960 §3.3.4). No gap-ack-blocks / duplicate-TSN support — for
 * a single reliable stream against one relay, a plain cumulative ack is
 * sufficient; gap reporting only matters for optimizing retransmission of
 * patterns we don't try to optimize here (missing it costs some efficiency
 * under loss, not correctness — our own retransmit-on-timeout still covers
 * a genuinely dropped DATA chunk). */
export function buildSack({ cumulativeTsnAck, advertisedReceiverWindow }) {
  const value = Buffer.alloc(12); // cumTsnAck(4) a_rwnd(4) numGapBlocks(2)=0 numDupTsn(2)=0
  value.writeUInt32BE(cumulativeTsnAck >>> 0, 0);
  value.writeUInt32BE(advertisedReceiverWindow >>> 0, 4);
  return encodeChunk(ChunkType.SACK, 0, value);
}

export function parseSack(chunkValue) {
  const cumulativeTsnAck = chunkValue.readUInt32BE(0) >>> 0;
  const advertisedReceiverWindow = chunkValue.readUInt32BE(4) >>> 0;
  return { cumulativeTsnAck, advertisedReceiverWindow };
}

// ---- HEARTBEAT ----

export function buildHeartbeat(heartbeatInfo) {
  const paramHeader = Buffer.alloc(4);
  paramHeader.writeUInt16BE(1, 0); // Heartbeat Info parameter type
  paramHeader.writeUInt16BE(4 + heartbeatInfo.length, 2);
  return encodeChunk(ChunkType.HEARTBEAT, 0, Buffer.concat([paramHeader, heartbeatInfo, Buffer.alloc(pad4(4 + heartbeatInfo.length))]));
}

export function buildHeartbeatAck(heartbeatParamValue) {
  // Echo back exactly the parameter TLV we received (RFC 4960 §8.3: HEARTBEAT
  // ACK MUST contain the Heartbeat Info parameter verbatim from the request).
  const paramHeader = Buffer.alloc(4);
  paramHeader.writeUInt16BE(1, 0);
  paramHeader.writeUInt16BE(4 + heartbeatParamValue.length, 2);
  return encodeChunk(ChunkType.HEARTBEAT_ACK, 0, Buffer.concat([paramHeader, heartbeatParamValue, Buffer.alloc(pad4(4 + heartbeatParamValue.length))]));
}

/** Extracts the raw Heartbeat Info TLV value from a HEARTBEAT chunk's value, for echoing in the ACK. */
export function parseHeartbeatInfo(chunkValue) {
  const paramLength = chunkValue.readUInt16BE(2);
  return chunkValue.subarray(4, paramLength);
}

export function buildAbort(reasonText = '') {
  return encodeChunk(ChunkType.ABORT, 0, Buffer.from(reasonText, 'utf8'));
}
