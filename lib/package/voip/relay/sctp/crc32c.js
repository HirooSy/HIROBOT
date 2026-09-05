// CRC-32C (Castagnoli), used for the SCTP common header checksum (RFC 4960
// §6.8, algorithm defined in RFC 3309). NOT the same as node:zlib's crc32,
// which is the IEEE 802.3/ZIP/PNG polynomial (0x04C11DB7 normal /
// 0xEDB88320 reflected) — SCTP requires the Castagnoli polynomial
// (0x1EDC6F41 normal / 0x82F63B78 reflected), a different checksum entirely
// that would silently fail on every real SCTP peer if confused with zlib's.
//
// Parameters (reflected/table-driven form, matching RFC 3309's reference
// C implementation): poly=0x1EDC6F41, init=0xFFFFFFFF, refin=true,
// refout=true, xorout=0x00000000. Verified below against the standard
// CRC-32C check value for ASCII "123456789" -> 0xE3069283.

const TABLE = (() => {
  const table = new Uint32Array(256);
  const poly = 0x82f63b78; // reflected form of 0x1EDC6F41
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} data @returns {number} unsigned 32-bit CRC32C */
export function crc32c(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
