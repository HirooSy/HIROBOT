import { badData, noSupport } from '../errors.js';
import { createRgba, toRgba, hasAlpha } from './frame.js';

function isBmp(buf) {
  return buf.length >= 30 && buf[0] === 0x42 && buf[1] === 0x4d;
}

function probeBmp(buf) {
  if (!isBmp(buf)) return null;
  const size = buf.readUInt32LE(14);
  if (size === 12) return { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) };
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
}

function decodeBmp(buf) {
  if (!isBmp(buf)) throw badData('not a bmp');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw noSupport('unsupported bmp header');
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (!(width > 0 && height > 0) || width * height > 268435456) throw badData('invalid bmp size');
  if (compression !== 0 && compression !== 3) throw noSupport('compressed bmp is not supported');
  let colors = buf.readUInt32LE(46);
  const paletteOffset = 14 + headerSize;
  let masks = null;
  if (compression === 3 || bpp === 16 || bpp === 32) {
    if (compression === 3) masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), headerSize >= 56 ? buf.readUInt32LE(66) : 0];
    else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  }
  if (bpp <= 8 && !colors) colors = 1 << bpp;
  const out = createRgba(width, height);
  const dst = out.planes[0].data;
  const rowBytes = Math.floor((width * bpp + 31) / 32) * 4;
  if (dataOffset + rowBytes * height > buf.length + rowBytes) throw badData('truncated bmp');
  const ext = (v, mask) => {
    if (!mask) return 255;
    let shift = 0;
    while (!((mask >>> shift) & 1)) shift++;
    const bits = (mask >>> shift).toString(2).length;
    const val = (v & mask) >>> shift;
    return bits >= 8 ? val >> (bits - 8) : Math.round((val * 255) / ((1 << bits) - 1));
  };
  for (let y = 0; y < height; y++) {
    const sy = topDown ? y : height - 1 - y;
    const row = dataOffset + sy * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 24) {
        dst[o] = buf[row + x * 3 + 2];
        dst[o + 1] = buf[row + x * 3 + 1];
        dst[o + 2] = buf[row + x * 3];
        dst[o + 3] = 255;
      } else if (bpp === 32) {
        if (masks) {
          const v = buf.readUInt32LE(row + x * 4);
          dst[o] = ext(v, masks[0]);
          dst[o + 1] = ext(v, masks[1]);
          dst[o + 2] = ext(v, masks[2]);
          dst[o + 3] = masks[3] ? ext(v, masks[3]) : 255;
        } else {
          dst[o] = buf[row + x * 4 + 2];
          dst[o + 1] = buf[row + x * 4 + 1];
          dst[o + 2] = buf[row + x * 4];
          dst[o + 3] = 255;
        }
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(row + x * 2);
        dst[o] = ext(v, masks[0]);
        dst[o + 1] = ext(v, masks[1]);
        dst[o + 2] = ext(v, masks[2]);
        dst[o + 3] = 255;
      } else if (bpp === 8 || bpp === 4 || bpp === 1) {
        const bitPos = x * bpp;
        const idx = (buf[row + (bitPos >> 3)] >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        const p = paletteOffset + idx * 4;
        dst[o] = buf[p + 2];
        dst[o + 1] = buf[p + 1];
        dst[o + 2] = buf[p];
        dst[o + 3] = 255;
      } else throw noSupport('unsupported bmp depth');
    }
  }
  return out;
}

function encodeBmp(frame) {
  const rgba = toRgba(frame);
  const alpha = hasAlpha(rgba);
  const { width, height } = rgba;
  const bpp = alpha ? 32 : 24;
  const rowBytes = Math.floor((width * bpp + 31) / 32) * 4;
  const header = 14 + 40;
  const out = Buffer.alloc(header + rowBytes * height);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(header, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bpp, 28);
  out.writeUInt32LE(rowBytes * height, 34);
  const src = rgba.planes[0].data;
  for (let y = 0; y < height; y++) {
    const row = header + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = row + x * (bpp >> 3);
      out[o] = src[i + 2];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i];
      if (alpha) out[o + 3] = src[i + 3];
    }
  }
  return out;
}

export { isBmp, probeBmp, decodeBmp, encodeBmp };
