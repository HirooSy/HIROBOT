
export const HandshakeType = Object.freeze({
  HELLO_REQUEST: 0,
  CLIENT_HELLO: 1,
  SERVER_HELLO: 2,
  HELLO_VERIFY_REQUEST: 3,
  CERTIFICATE: 11,
  SERVER_KEY_EXCHANGE: 12,
  CERTIFICATE_REQUEST: 13,
  SERVER_HELLO_DONE: 14,
  CERTIFICATE_VERIFY: 15,
  CLIENT_KEY_EXCHANGE: 16,
  FINISHED: 20,
});

const HANDSHAKE_HEADER_LEN = 12;

function writeUint24BE(buf, offset, value) {
  buf.writeUInt8((value >> 16) & 0xff, offset);
  buf.writeUInt8((value >> 8) & 0xff, offset + 1);
  buf.writeUInt8(value & 0xff, offset + 2);
}
function readUint24BE(buf, offset) {
  return (buf.readUInt8(offset) << 16) | (buf.readUInt8(offset + 1) << 8) | buf.readUInt8(offset + 2);
}

export function encodeHandshakeMessage({ msgType, messageSeq, body, maxFragmentSize = 1200 }) {
  const totalLength = body.length;
  if (totalLength <= maxFragmentSize) {
    const header = Buffer.alloc(HANDSHAKE_HEADER_LEN);
    header.writeUInt8(msgType, 0);
    writeUint24BE(header, 1, totalLength);
    header.writeUInt16BE(messageSeq, 4);
    writeUint24BE(header, 6, 0);
    writeUint24BE(header, 9, totalLength);
    return [Buffer.concat([header, body])];
  }
  const fragments = [];
  let offset = 0;
  while (offset < totalLength) {
    const fragLen = Math.min(maxFragmentSize, totalLength - offset);
    const header = Buffer.alloc(HANDSHAKE_HEADER_LEN);
    header.writeUInt8(msgType, 0);
    writeUint24BE(header, 1, totalLength);
    header.writeUInt16BE(messageSeq, 4);
    writeUint24BE(header, 6, offset);
    writeUint24BE(header, 9, fragLen);
    fragments.push(Buffer.concat([header, body.subarray(offset, offset + fragLen)]));
    offset += fragLen;
  }
  return fragments;
}

export function decodeHandshakeFragment(buf) {
  const msgType = buf.readUInt8(0);
  const length = readUint24BE(buf, 1);
  const messageSeq = buf.readUInt16BE(4);
  const fragmentOffset = readUint24BE(buf, 6);
  const fragmentLength = readUint24BE(buf, 9);
  const body = buf.subarray(HANDSHAKE_HEADER_LEN, HANDSHAKE_HEADER_LEN + fragmentLength);
  return {
    msgType, length, messageSeq, fragmentOffset, fragmentLength, body,
    consumed: HANDSHAKE_HEADER_LEN + fragmentLength,
  };
}

export class HandshakeReassembler {
  #pending = new Map();

  addFragment({ msgType, length, messageSeq, fragmentOffset, fragmentLength, body }) {
    if (fragmentOffset === 0 && fragmentLength === length) {

      return { msgType, messageSeq, body: Buffer.from(body) };
    }
    let entry = this.#pending.get(messageSeq);
    if (!entry) {
      entry = { length, msgType, chunks: new Map() };
      this.#pending.set(messageSeq, entry);
    }
    entry.chunks.set(fragmentOffset, Buffer.from(body));

    let covered = 0;
    for (const chunk of entry.chunks.values()) covered += chunk.length;
    if (covered < entry.length) return null;
    const sortedOffsets = [...entry.chunks.keys()].sort((a, b) => a - b);
    const assembled = Buffer.concat(sortedOffsets.map((off) => entry.chunks.get(off)));
    this.#pending.delete(messageSeq);
    return { msgType: entry.msgType, messageSeq, body: assembled.subarray(0, entry.length) };
  }
}

export function logicalHandshakeBytes({ msgType, messageSeq, body }) {
  const header = Buffer.alloc(HANDSHAKE_HEADER_LEN);
  header.writeUInt8(msgType, 0);
  writeUint24BE(header, 1, body.length);
  header.writeUInt16BE(messageSeq, 4);
  writeUint24BE(header, 6, 0);
  writeUint24BE(header, 9, body.length);
  return Buffer.concat([header, body]);
}
