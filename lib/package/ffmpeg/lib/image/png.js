import zlib from 'node:zlib';
import { badData, noSupport } from '../errors.js';
import { createRgba, createGray, toRgba, hasAlpha } from './frame.js';

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(buf) {
  return buf.length >= 8 && buf.compare(signature, 0, 8, 0, 8) === 0;
}

function readHeader(buf) {
  if (!isPng(buf) || buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') throw badData('not a png');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

function probePng(buf) {
  if (!isPng(buf) || buf.length < 33) return null;
  const h = readHeader(buf);
  return { width: h.width, height: h.height, colorType: h.colorType, depth: h.depth };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(data, offset, width, height, bpp, rowBytes) {
  const out = new Uint8Array(rowBytes * height);
  let pos = offset;
  for (let y = 0; y < height; y++) {
    const ft = data[pos++];
    const row = y * rowBytes;
    const prev = row - rowBytes;
    if (ft > 4) throw badData('invalid png filter');
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[pos++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      let v;
      if (ft === 0) v = raw;
      else if (ft === 1) v = raw + a;
      else if (ft === 2) v = raw + b;
      else if (ft === 3) v = raw + ((a + b) >> 1);
      else v = raw + paeth(a, b, x >= bpp && y > 0 ? out[prev + x - bpp] : 0);
      out[row + x] = v & 255;
    }
  }
  return { out, end: pos };
}

function decodePng(buf) {
  const hdr = readHeader(buf);
  const { width, height, depth, colorType, interlace } = hdr;
  if (!(width > 0 && height > 0) || width * height > 268435456) throw badData('invalid png size');
  const ch = channelsByType[colorType];
  if (!ch) throw badData('invalid png color type');
  if (![1, 2, 4, 8, 16].includes(depth)) throw badData('invalid png bit depth');
  let palette = null;
  let trns = null;
  const idat = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = pos + 8;
    if (body + len > buf.length) throw badData('truncated png chunk');
    if (type === 'PLTE') palette = buf.subarray(body, body + len);
    else if (type === 'tRNS') trns = buf.subarray(body, body + len);
    else if (type === 'IDAT') idat.push(buf.subarray(body, body + len));
    else if (type === 'IEND') break;
    pos = body + len + 4;
  }
  if (!idat.length) throw badData('png has no image data');
  if (colorType === 3 && !palette) throw badData('png palette missing');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = ch * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const sample = (row, rowOff, x, c) => {
    if (depth === 8) return row[rowOff + x * ch + c];
    if (depth === 16) return (row[rowOff + (x * ch + c) * 2] << 8) | row[rowOff + (x * ch + c) * 2 + 1];
    const bitPos = (x * ch + c) * depth;
    const byte = row[rowOff + (bitPos >> 3)];
    return (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
  };
  const maxv = (1 << depth) - 1;
  const scale8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxv));
  const keyed = trns && (colorType === 0 || colorType === 2);
  const plain = colorType === 0 && !trns;
  const out = plain ? createGray(width, height) : createRgba(width, height);
  const dst = out.planes[0].data;
  const put = (row, rowOff, sx, dx, dy) => {
    if (plain) {
      dst[dy * width + dx] = scale8(sample(row, rowOff, sx, 0));
      return;
    }
    const o = (dy * width + dx) * 4;
    if (colorType === 0) {
      const g = sample(row, rowOff, sx, 0);
      dst[o] = dst[o + 1] = dst[o + 2] = scale8(g);
      dst[o + 3] = keyed && g === ((trns[0] << 8) | trns[1]) ? 0 : 255;
    } else if (colorType === 2) {
      const r = sample(row, rowOff, sx, 0);
      const g = sample(row, rowOff, sx, 1);
      const b = sample(row, rowOff, sx, 2);
      dst[o] = scale8(r);
      dst[o + 1] = scale8(g);
      dst[o + 2] = scale8(b);
      dst[o + 3] = keyed && r === ((trns[0] << 8) | trns[1]) && g === ((trns[2] << 8) | trns[3]) && b === ((trns[4] << 8) | trns[5]) ? 0 : 255;
    } else if (colorType === 3) {
      const i = sample(row, rowOff, sx, 0);
      dst[o] = palette[i * 3];
      dst[o + 1] = palette[i * 3 + 1];
      dst[o + 2] = palette[i * 3 + 2];
      dst[o + 3] = trns && i < trns.length ? trns[i] : 255;
    } else if (colorType === 4) {
      const g = scale8(sample(row, rowOff, sx, 0));
      dst[o] = dst[o + 1] = dst[o + 2] = g;
      dst[o + 3] = scale8(sample(row, rowOff, sx, 1));
    } else {
      dst[o] = scale8(sample(row, rowOff, sx, 0));
      dst[o + 1] = scale8(sample(row, rowOff, sx, 1));
      dst[o + 2] = scale8(sample(row, rowOff, sx, 2));
      dst[o + 3] = scale8(sample(row, rowOff, sx, 3));
    }
  };
  if (!interlace) {
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
    if (raw.length < (rowBytes + 1) * height) throw badData('truncated png data');
    const { out: px } = unfilter(raw, 0, width, height, bpp, rowBytes);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(px, y * rowBytes, x, x, y);
    return out;
  }
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  let off = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    if (raw.length < off + (rowBytes + 1) * ph) throw badData('truncated png data');
    const { out: px, end } = unfilter(raw, off, pw, ph, bpp, rowBytes);
    off = end;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) put(px, y * rowBytes, x, x0 + x * dx, y0 + y * dy);
  }
  return out;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function encodePng(frame, options = {}) {
  let colorType;
  let ch;
  let src;
  if (frame.format === 'gray') {
    colorType = 0;
    ch = 1;
    src = frame.planes[0].data;
  } else {
    const rgba = toRgba(frame);
    const alpha = hasAlpha(rgba);
    colorType = alpha ? 6 : 2;
    ch = alpha ? 4 : 3;
    const d = rgba.planes[0].data;
    if (alpha) src = d;
    else {
      src = new Uint8Array(rgba.width * rgba.height * 3);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        src[j] = d[i];
        src[j + 1] = d[i + 1];
        src[j + 2] = d[i + 2];
      }
    }
  }
  const { width, height } = frame;
  const rowBytes = width * ch;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const cand = [new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes)];
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = src[row + x];
      const a = x >= ch ? src[row + x - ch] : 0;
      const b = y > 0 ? src[prev + x] : 0;
      const c = x >= ch && y > 0 ? src[prev + x - ch] : 0;
      cand[0][x] = v;
      cand[1][x] = (v - a) & 255;
      cand[2][x] = (v - b) & 255;
      cand[3][x] = (v - ((a + b) >> 1)) & 255;
      cand[4][x] = (v - paeth(a, b, c)) & 255;
    }
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      const c = cand[f];
      for (let x = 0; x < rowBytes; x++) sum += c[x] < 128 ? c[x] : 256 - c[x];
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (rowBytes + 1)] = best;
    raw.set(cand[best], y * (rowBytes + 1) + 1);
  }
  const level = options.level === undefined ? 6 : Math.min(9, Math.max(0, options.level));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', new Uint8Array(0))]);
}

export { isPng, probePng, decodePng, encodePng };
