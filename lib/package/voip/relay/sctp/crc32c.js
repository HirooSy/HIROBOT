
const TABLE = (() => {
  const table = new Uint32Array(256);
  const poly = 0x82f63b78;
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
