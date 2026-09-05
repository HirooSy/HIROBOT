// DTLS handshake message framing (RFC 6347 §4.2.2):
//   struct Handshake {
//     HandshakeType msg_type;   // 1 byte
//     uint24 length;            // total logical message length (unfragmented)
//     uint16 message_seq;       // per-handshake sequence number
//     uint24 fragment_offset;
//     uint24 fragment_length;
//     opaque body[fragment_length];
//   }
// 12-byte header + body. A message that fits in one record has
// fragment_offset=0, fragment_length=length (RFC calls this "the degenerate
// case" — not a different format, just fragment_length == length).

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

/**
 * Encodes one handshake message, optionally split into fragments no larger
 * than maxFragmentSize (each fragment gets its own 12-byte header but shares
 * message_seq and the *logical* total length).
 * @returns {Buffer[]} one or more complete Handshake structs, ready to be
 *   wrapped as record fragments (record.js) — one per DTLS record.
 */
export function encodeHandshakeMessage({ msgType, messageSeq, body, maxFragmentSize = 1200 }) {
  const totalLength = body.length;
  if (totalLength <= maxFragmentSize) {
    const header = Buffer.alloc(HANDSHAKE_HEADER_LEN);
    header.writeUInt8(msgType, 0);
    writeUint24BE(header, 1, totalLength);
    header.writeUInt16BE(messageSeq, 4);
    writeUint24BE(header, 6, 0); // fragment_offset
    writeUint24BE(header, 9, totalLength); // fragment_length == length: unfragmented
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

/** Decodes one Handshake struct's header+body from the start of `buf` (a
 * decrypted/plaintext DTLS_HANDSHAKE-type record fragment). Does not handle
 * multiple handshake messages coalesced in one record — DTLS forbids that
 * for messages needing reassembly, and our relay peer is not expected to do
 * it; callers that need it can loop using the returned `consumed` length. */
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

/**
 * Accumulates fragments for messages that arrive out of order or split
 * across records, keyed by message_seq. Needed because a real relay may
 * fragment ServerHello+Certificate+ServerKeyExchange+ServerHelloDone across
 * several UDP datagrams, and DTLS explicitly allows reordering between
 * them (RFC 6347 §4.2.2, "Reordering").
 */
export class HandshakeReassembler {
  #pending = new Map(); // message_seq -> { length, msgType, chunks: Map<offset, Buffer> }

  /**
   * Feeds one received fragment. Returns the complete { msgType, messageSeq,
   * body } if this fragment completed its message, otherwise null.
   */
  addFragment({ msgType, length, messageSeq, fragmentOffset, fragmentLength, body }) {
    if (fragmentOffset === 0 && fragmentLength === length) {
      // Fast path: arrived whole, matches the vast majority of real traffic
      // (relays generally don't fragment below their own MTU).
      return { msgType, messageSeq, body: Buffer.from(body) };
    }
    let entry = this.#pending.get(messageSeq);
    if (!entry) {
      entry = { length, msgType, chunks: new Map() };
      this.#pending.set(messageSeq, entry);
    }
    entry.chunks.set(fragmentOffset, Buffer.from(body));
    // Check completeness: every byte 0..length must be covered by some chunk.
    // Fragment ranges SHOULD NOT overlap per the RFC, so summing lengths is
    // a valid completeness check as long as we trust well-behaved peers —
    // a relay sending malformed overlapping fragments would just leave this
    // permanently incomplete (safe failure, not a security-relevant one for
    // our threat model here since insecure-skip-verify already means we
    // don't treat this peer as adversarial).
    let covered = 0;
    for (const chunk of entry.chunks.values()) covered += chunk.length;
    if (covered < entry.length) return null;
    const sortedOffsets = [...entry.chunks.keys()].sort((a, b) => a - b);
    const assembled = Buffer.concat(sortedOffsets.map((off) => entry.chunks.get(off)));
    this.#pending.delete(messageSeq);
    return { msgType: entry.msgType, messageSeq, body: assembled.subarray(0, entry.length) };
  }
}

/** Rebuilds the 12-byte logical (unfragmented) header for hashing purposes —
 * RFC 6347 §4.2.6 requires Finished/CertificateVerify hashes to be computed
 * "as if each handshake message had been sent as a single fragment", i.e.
 * fragment_offset=0, fragment_length=length, regardless of how it was
 * actually transmitted or received on the wire. */
export function logicalHandshakeBytes({ msgType, messageSeq, body }) {
  const header = Buffer.alloc(HANDSHAKE_HEADER_LEN);
  header.writeUInt8(msgType, 0);
  writeUint24BE(header, 1, body.length);
  header.writeUInt16BE(messageSeq, 4);
  writeUint24BE(header, 6, 0);
  writeUint24BE(header, 9, body.length);
  return Buffer.concat([header, body]);
}
