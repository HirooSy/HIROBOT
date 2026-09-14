
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const der = {
  sequence: (...parts) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts) => tlv(0x31, Buffer.concat(parts)),
  contextConstructed: (tagNumber, ...parts) => tlv(0xa0 | tagNumber, Buffer.concat(parts)),

  integer: (value) => {

    let bytes;
    if (Buffer.isBuffer(value)) {
      bytes = value;
    } else {
      let n = BigInt(value);
      if (n === 0n) {
        bytes = Buffer.from([0]);
      } else {
        const out = [];
        while (n > 0n) {
          out.unshift(Number(n & 0xffn));
          n >>= 8n;
        }
        bytes = Buffer.from(out);
      }
    }

    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(0x02, bytes);
  },

  bitString: (content, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content])),
  octetString: (content) => tlv(0x04, content),
  nullValue: () => Buffer.from([0x05, 0x00]),
  objectIdentifier: (dotted) => {
    const parts = dotted.split('.').map(Number);
    const first = parts[0] * 40 + parts[1];
    const bytes = [first];
    for (const part of parts.slice(2)) {
      if (part < 0x80) {
        bytes.push(part);
        continue;
      }
      const chunk = [];
      let n = part;
      chunk.unshift(n & 0x7f);
      n >>>= 7;
      while (n > 0) {
        chunk.unshift((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      bytes.push(...chunk);
    }
    return tlv(0x06, Buffer.from(bytes));
  },
  utf8String: (str) => tlv(0x0c, Buffer.from(str, 'utf8')),
  printableString: (str) => tlv(0x13, Buffer.from(str, 'ascii')),

  utcTime: (date) => {
    const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return tlv(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
  },
};

export function readTlv(buf, offset = 0) {
  const tag = buf.readUInt8(offset);
  let lenByte = buf.readUInt8(offset + 1);
  let lenStart = offset + 2;
  let length;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | buf.readUInt8(lenStart + i);
    lenStart += numBytes;
  } else {
    length = lenByte;
  }
  const content = buf.subarray(lenStart, lenStart + length);
  return { tag, content, next: lenStart + length };
}
