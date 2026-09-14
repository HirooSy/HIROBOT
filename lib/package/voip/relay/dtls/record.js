
export const ContentType = Object.freeze({
  CHANGE_CIPHER_SPEC: 20,
  ALERT: 21,
  HANDSHAKE: 22,
  APPLICATION_DATA: 23,
});

export const DTLS_1_2_VERSION = Buffer.from([0xfe, 0xfd]);

const RECORD_HEADER_LEN = 13;

export function encodeEpochSeq(epoch, sequenceNumber) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(epoch, 0);

  buf.writeUIntBE(Number(sequenceNumber & 0xffffffffffffn), 2, 6);
  return buf;
}

export function decodeEpochSeq(buf) {
  const epoch = buf.readUInt16BE(0);
  const sequenceNumber = BigInt(buf.readUIntBE(2, 6));
  return { epoch, sequenceNumber };
}

export function encodeRecord({ type, epoch, sequenceNumber, fragment }) {
  const header = Buffer.alloc(RECORD_HEADER_LEN);
  header.writeUInt8(type, 0);
  DTLS_1_2_VERSION.copy(header, 1);
  encodeEpochSeq(epoch, sequenceNumber).copy(header, 3);
  header.writeUInt16BE(fragment.length, 11);
  return Buffer.concat([header, fragment]);
}

export function decodeRecords(datagram) {
  const records = [];
  let offset = 0;
  while (offset + RECORD_HEADER_LEN <= datagram.length) {
    const type = datagram.readUInt8(offset);

    const { epoch, sequenceNumber } = decodeEpochSeq(datagram.subarray(offset + 3, offset + 11));
    const length = datagram.readUInt16BE(offset + 11);
    const fragmentStart = offset + RECORD_HEADER_LEN;
    const fragmentEnd = fragmentStart + length;
    if (fragmentEnd > datagram.length) break;
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
