// DTLS 1.2 record layer (RFC 6347 §4.1). Pure byte-level framing — no crypto,
// no I/O. This is the lowest layer of the from-scratch DTLS client that
// replaces `wrtc`+ICE for the relay transport (wrtc forces a real ICE
// connectivity check, which the WhatsApp relay does not speak; the relay only
// speaks raw UDP -> DTLS -> SCTP -> DataChannel, mirroring meowcaller's Go
// reference in relay/relay.go, which uses pion/dtls directly with no ICE at
// all).
//
// struct DTLSPlaintext {
//   ContentType type;        // 1 byte
//   ProtocolVersion version; // 2 bytes: {0xfe, 0xfd} for DTLS 1.2
//   uint16 epoch;
//   uint48 sequence_number;  // 6 bytes
//   uint16 length;
//   opaque fragment[length];
// }
// Ciphertext has the same header; `fragment` is the encrypted GenericAEADCipher.

export const ContentType = Object.freeze({
  CHANGE_CIPHER_SPEC: 20,
  ALERT: 21,
  HANDSHAKE: 22,
  APPLICATION_DATA: 23,
});

export const DTLS_1_2_VERSION = Buffer.from([0xfe, 0xfd]);

const RECORD_HEADER_LEN = 13; // type(1) + version(2) + epoch(2) + seq(6) + length(2)

/**
 * @param {number} epoch
 * @param {bigint} sequenceNumber - 48-bit, caller keeps this monotonic per epoch
 * @returns {Buffer} 8-byte epoch(2)+sequence(6) field, used both in the record
 *   header and (unencrypted) as the AEAD nonce/additional-data component.
 */
export function encodeEpochSeq(epoch, sequenceNumber) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(epoch, 0);
  // 48-bit big-endian integer: split into hi16/lo32 since Buffer has no
  // writeUIntBE wider than 48 bits in one call on some Node versions — use
  // the 6-byte form directly for clarity and to avoid the 2^53 float trap.
  buf.writeUIntBE(Number(sequenceNumber & 0xffffffffffffn), 2, 6);
  return buf;
}

export function decodeEpochSeq(buf) {
  const epoch = buf.readUInt16BE(0);
  const sequenceNumber = BigInt(buf.readUIntBE(2, 6));
  return { epoch, sequenceNumber };
}

/**
 * Encodes one DTLS record (header + already-prepared fragment, which the
 * caller has encrypted if epoch > 0).
 * @param {{ type: number, epoch: number, sequenceNumber: bigint, fragment: Buffer }} record
 */
export function encodeRecord({ type, epoch, sequenceNumber, fragment }) {
  const header = Buffer.alloc(RECORD_HEADER_LEN);
  header.writeUInt8(type, 0);
  DTLS_1_2_VERSION.copy(header, 1);
  encodeEpochSeq(epoch, sequenceNumber).copy(header, 3);
  header.writeUInt16BE(fragment.length, 11);
  return Buffer.concat([header, fragment]);
}

/**
 * Splits a raw UDP datagram into however many DTLS records it contains (the
 * peer may coalesce several records into one datagram). Malformed trailing
 * bytes are dropped rather than throwing, since a truncated/garbage tail on
 * an unreliable transport is expected, not exceptional.
 * @param {Buffer} datagram
 * @returns {Array<{ type: number, epoch: number, sequenceNumber: bigint, fragment: Buffer }>}
 */
export function decodeRecords(datagram) {
  const records = [];
  let offset = 0;
  while (offset + RECORD_HEADER_LEN <= datagram.length) {
    const type = datagram.readUInt8(offset);
    // version bytes at offset+1..2 intentionally unchecked: some relays/impls
    // are lax here and we gain nothing by rejecting on it.
    const { epoch, sequenceNumber } = decodeEpochSeq(datagram.subarray(offset + 3, offset + 11));
    const length = datagram.readUInt16BE(offset + 11);
    const fragmentStart = offset + RECORD_HEADER_LEN;
    const fragmentEnd = fragmentStart + length;
    if (fragmentEnd > datagram.length) break; // truncated tail, stop parsing
    records.push({
      type,
      epoch,
      sequenceNumber,
      fragment: datagram.subarray(fragmentStart, fragmentEnd),
    });
    offset = fragmentEnd;
  }
  return records;
}
