import { badData, noSupport } from '../errors.js';
import { createRgba } from './frame.js';

function isGif(buf) {
  return buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF' && (buf.toString('latin1', 3, 6) === '87a' || buf.toString('latin1', 3, 6) === '89a');
}

function probeGif(buf) {
  if (!isGif(buf)) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function lzwDecode(data, minCode, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCode + 1;
  let next = eoi + 1;
  let prev = -1;
  let first = 0;
  let bits = 0;
  let acc = 0;
  let pos = 0;
  let o = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  while (o < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out;
      acc |= data[pos++] << bits;
      bits += 8;
    }
    let code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev === -1) {
      out[o++] = suffix[code];
      prev = code;
      first = code;
      continue;
    }
    const incoming = code;
    let sp = 0;
    if (code >= next) {
      stack[sp++] = first;
      code = prev;
    }
    while (code >= clear) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[sp++] = first;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if ((next & (next - 1)) === 0 && next < 4096) codeSize++;
    }
    prev = incoming;
    while (sp > 0 && o < pixelCount) out[o++] = stack[--sp];
  }
  return out;
}

function forEachGifFrame(buf, visit) {
  if (!isGif(buf)) throw badData('not a gif');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) throw badData('invalid gif size');
  if (width * height > 100000000) throw noSupport('gif is too large');
  const flags = buf[10];
  const bgIndex = buf[11];
  let pos = 13;
  let globalPalette = null;
  if (flags & 0x80) {
    const n = 3 << ((flags & 7) + 1);
    globalPalette = buf.subarray(pos, pos + n);
    pos += n;
  }
  const d = createRgba(width, height).planes[0].data;
  const fillAll = (rgba) => {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = rgba[0];
      d[i + 1] = rgba[1];
      d[i + 2] = rgba[2];
      d[i + 3] = rgba[3];
    }
  };
  const transparentWhite = [255, 255, 255, 0];
  const bgColor = globalPalette && bgIndex * 3 + 2 < globalPalette.length ? [globalPalette[bgIndex * 3], globalPalette[bgIndex * 3 + 1], globalPalette[bgIndex * 3 + 2], 255] : transparentWhite;
  let started = false;
  let gce = null;
  let loop = 1;
  let visited = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[pos++];
      if (label === 0xf9 && buf[pos] >= 4) {
        gce = { disposal: (buf[pos + 1] >> 2) & 7, transparent: buf[pos + 1] & 1 ? buf[pos + 4] : -1, delay: buf.readUInt16LE(pos + 2) * 10 };
      } else if (label === 0xff && buf.toString('latin1', pos + 1, pos + 12) === 'NETSCAPE2.0') {
        loop = buf.readUInt16LE(pos + 14);
      }
      while (pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1;
      pos++;
      continue;
    }
    if (b !== 0x2c) throw badData('invalid gif block');
    const fx = buf.readUInt16LE(pos);
    const fy = buf.readUInt16LE(pos + 2);
    const fw = buf.readUInt16LE(pos + 4);
    const fh = buf.readUInt16LE(pos + 6);
    const fflags = buf[pos + 8];
    pos += 9;
    let palette = globalPalette;
    if (fflags & 0x80) {
      const n = 3 << ((fflags & 7) + 1);
      palette = buf.subarray(pos, pos + n);
      pos += n;
    }
    const minCode = buf[pos++];
    if (minCode < 1 || minCode > 11) throw badData('invalid gif code size');
    const chunks = [];
    while (pos < buf.length && buf[pos] !== 0) {
      chunks.push(buf.subarray(pos + 1, pos + 1 + buf[pos]));
      pos += buf[pos] + 1;
    }
    pos++;
    if (!palette) throw badData('gif has no palette');
    const indices = lzwDecode(Buffer.concat(chunks), minCode, fw * fh);
    const info = gce || { disposal: 0, transparent: -1, delay: 0 };
    gce = null;
    if (!started) {
      started = true;
      fillAll(info.transparent === -1 && globalPalette ? bgColor : transparentWhite);
    }
    const saved = info.disposal === 3 ? Uint8Array.from(d) : null;
    const interlaced = (fflags & 0x40) !== 0;
    const rowMap = new Int32Array(fh);
    if (interlaced) {
      let r = 0;
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < fh; y += step) rowMap[r++] = y;
    } else for (let y = 0; y < fh; y++) rowMap[y] = y;
    for (let r = 0; r < fh; r++) {
      const y = fy + rowMap[r];
      if (y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const px = fx + x;
        if (px >= width) continue;
        const idx = indices[r * fw + x];
        if (idx === info.transparent) continue;
        const o = (y * width + px) * 4;
        d[o] = palette[idx * 3];
        d[o + 1] = palette[idx * 3 + 1];
        d[o + 2] = palette[idx * 3 + 2];
        d[o + 3] = 255;
      }
    }
    visited++;
    if (visit(d, info.delay, width, height)) break;
    if (info.disposal === 2) {
      for (let y = fy; y < Math.min(height, fy + fh); y++) {
        for (let x = fx; x < Math.min(width, fx + fw); x++) {
          const o = (y * width + x) * 4;
          const c = info.transparent >= 0 ? transparentWhite : bgColor;
          d[o] = c[0];
          d[o + 1] = c[1];
          d[o + 2] = c[2];
          d[o + 3] = c[3];
        }
      }
    } else if (info.disposal === 3 && saved) d.set(saved);
  }
  if (!visited) throw badData('gif has no frames');
  return { width, height, loop, background: bgIndex };
}

function decodeGif(buf, options = {}) {
  const frames = [];
  return {
    ...forEachGifFrame(buf, (pixels, delay, width, height) => {
      const frame = createRgba(width, height);
      frame.planes[0].data.set(pixels);
      frames.push({ frame, delay });
      return frames.length >= (options.maxFrames || Infinity);
    }),
    frames,
  };
}

function decodeGifFrame(buf, startSec) {
  let elapsed = 0;
  let picked = null;
  forEachGifFrame(buf, (pixels, delay, width, height) => {
    picked ??= createRgba(width, height);
    picked.planes[0].data.set(pixels);
    if (elapsed / 1000 >= startSec - 1e-6) return true;
    elapsed += delay || 100;
    return false;
  });
  return picked;
}

export { isGif, probeGif, decodeGif, decodeGifFrame };
