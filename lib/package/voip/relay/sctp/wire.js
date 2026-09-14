import { crc32c } from './crc32c.js';

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

const COMMON_HEADER_LEN = 12;

function pad4(len) { return (4 - (len % 4)) % 4; }

export function buildPacket({ sourcePort, destinationPort, verificationTag, chunks }) {
  const header = Buffer.alloc(COMMON_HEADER_LEN);
  header.writeUInt16BE(sourcePort, 0);
  header.writeUInt16BE(destinationPort, 2);
  header.writeUInt32BE(verificationTag >>> 0, 4);

  const body = Buffer.concat(chunks);
  const packetWithZeroChecksum = Buffer.concat([header, body]);
  const checksum = crc32c(packetWithZeroChecksum);

  packetWithZeroChecksum.writeUInt32LE(checksum, 8);
  return packetWithZeroChecksum;
}

export function parsePacketHeader(datagram) {
  if (datagram.length < COMMON_HEADER_LEN) throw new Error('SCTP packet shorter than common header');
  const sourcePort = datagram.readUInt16BE(0);
  const destinationPort = datagram.readUInt16BE(2);
  const verificationTag = datagram.readUInt32BE(4) >>> 0;

  const receivedChecksum = datagram.readUInt32LE(8) >>> 0;
  const forVerification = Buffer.from(datagram);
  forVerification.writeUInt32BE(0, 8);
  const computedChecksum = crc32c(forVerification);
  if (computedChecksum !== receivedChecksum) {
    throw new Error(`SCTP checksum mismatch: got 0x${receivedChecksum.toString(16)}, computed 0x${computedChecksum.toString(16)}`);
  }
  return { sourcePort, destinationPort, verificationTag, chunksStart: COMMON_HEADER_LEN };
}

export function splitChunks(datagram, chunksStart) {
  const chunks = [];
  let offset = chunksStart;
  while (offset + 4 <= datagram.length) {
    const type = datagram.readUInt8(offset);
    const flags = datagram.readUInt8(offset + 1);
    const length = datagram.readUInt16BE(offset + 2);
    if (length < 4 || offset + length > datagram.length) break;
    chunks.push({ type, flags, value: datagram.subarray(offset + 4, offset + length) });
    offset += length + pad4(length);
  }
  return chunks;
}

export function encodeChunk(type, flags, value) {
  const length = 4 + value.length;
  const header = Buffer.alloc(4);
  header.writeUInt8(type, 0);
  header.writeUInt8(flags, 1);
  header.writeUInt16BE(length, 2);
  const padding = Buffer.alloc(pad4(length));
  return Buffer.concat([header, value, padding]);
}

const SUPPORTED_EXTENSIONS_PARAM_TYPE = 0x8008;
const CHUNK_TYPE_RECONFIG = 130;
const CHUNK_TYPE_FORWARD_TSN = 192;

function buildSupportedExtensionsParam() {
  const chunkTypes = Buffer.from([CHUNK_TYPE_RECONFIG, CHUNK_TYPE_FORWARD_TSN]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(SUPPORTED_EXTENSIONS_PARAM_TYPE, 0);
  header.writeUInt16BE(4 + chunkTypes.length, 2);
  return Buffer.concat([header, chunkTypes, Buffer.alloc(pad4(4 + chunkTypes.length))]);
}

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

  let offset = 16;
  let stateCookie = null;
  while (offset + 4 <= chunkValue.length) {
    const paramType = chunkValue.readUInt16BE(offset);
    const paramLength = chunkValue.readUInt16BE(offset + 2);
    if (paramLength < 4 || offset + paramLength > chunkValue.length) break;
    const paramValue = chunkValue.subarray(offset + 4, offset + paramLength);
    if (paramType === 7) stateCookie = paramValue;
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
  cookieParamHeader.writeUInt16BE(7, 0);
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

const DATA_HEADER_LEN = 12;

export function buildData({ tsn, streamId, streamSeq, ppid, payload, unordered = false, beginning = true, ending = true }) {
  let flags = 0;
  if (unordered) flags |= 0x04;
  if (beginning) flags |= 0x02;
  if (ending) flags |= 0x01;
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

export function buildSack({ cumulativeTsnAck, advertisedReceiverWindow }) {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(cumulativeTsnAck >>> 0, 0);
  value.writeUInt32BE(advertisedReceiverWindow >>> 0, 4);
  return encodeChunk(ChunkType.SACK, 0, value);
}

export function parseSack(chunkValue) {
  const cumulativeTsnAck = chunkValue.readUInt32BE(0) >>> 0;
  const advertisedReceiverWindow = chunkValue.readUInt32BE(4) >>> 0;
  return { cumulativeTsnAck, advertisedReceiverWindow };
}

export function buildHeartbeat(heartbeatInfo) {
  const paramHeader = Buffer.alloc(4);
  paramHeader.writeUInt16BE(1, 0);
  paramHeader.writeUInt16BE(4 + heartbeatInfo.length, 2);
  return encodeChunk(ChunkType.HEARTBEAT, 0, Buffer.concat([paramHeader, heartbeatInfo, Buffer.alloc(pad4(4 + heartbeatInfo.length))]));
}

export function buildHeartbeatAck(heartbeatParamValue) {

  const paramHeader = Buffer.alloc(4);
  paramHeader.writeUInt16BE(1, 0);
  paramHeader.writeUInt16BE(4 + heartbeatParamValue.length, 2);
  return encodeChunk(ChunkType.HEARTBEAT_ACK, 0, Buffer.concat([paramHeader, heartbeatParamValue, Buffer.alloc(pad4(4 + heartbeatParamValue.length))]));
}

export function parseHeartbeatInfo(chunkValue) {
  const paramLength = chunkValue.readUInt16BE(2);
  return chunkValue.subarray(4, paramLength);
}

export function buildAbort(reasonText = '') {
  return encodeChunk(ChunkType.ABORT, 0, Buffer.from(reasonText, 'utf8'));
}
