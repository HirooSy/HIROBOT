let table8;
let table16;
let tableOgg;

function build8() {
  table8 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    table8[i] = c;
  }
}

function build16() {
  table16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    table16[i] = c;
  }
}

function buildOgg() {
  tableOgg = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    tableOgg[i] = c;
  }
}

function crc8(buf, start, end, crc = 0) {
  if (!table8) build8();
  for (let i = start; i < end; i++) crc = table8[crc ^ buf[i]];
  return crc;
}

function crc16(buf, start, end, crc = 0) {
  if (!table16) build16();
  for (let i = start; i < end; i++) crc = ((crc << 8) & 0xffff) ^ table16[(crc >>> 8) ^ buf[i]];
  return crc;
}

function crc32ogg(buf, start, end, crc = 0) {
  if (!tableOgg) buildOgg();
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ tableOgg[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}

function crc16Table() {
  if (!table16) build16();
  return table16;
}

export {
  crc8,
  crc16,
  crc32ogg,
  crc16Table,
};
