import { noSupport } from '../errors.js';

const formats = {
  pcm_u8: { bytes: 1, bits: 8 },
  pcm_s16le: { bytes: 2, bits: 16 },
  pcm_s24le: { bytes: 3, bits: 24 },
  pcm_s32le: { bytes: 4, bits: 32 },
  pcm_f32le: { bytes: 4, bits: 32, float: true },
  pcm_f64le: { bytes: 8, bits: 64, float: true },
  pcm_alaw: { bytes: 1, bits: 8 },
  pcm_mulaw: { bytes: 1, bits: 8 },
};

let alawTable;
let mulawTable;

function buildTables() {
  alawTable = new Float64Array(256);
  mulawTable = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    let a = i ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) t += 8;
    else {
      t += 0x108;
      if (seg > 1) t <<= seg - 1;
    }
    alawTable[i] = ((a & 0x80) ? t : -t) / 32768;
    const u = ~i & 0xff;
    let m = ((u & 0x0f) << 3) + 0x84;
    m <<= (u & 0x70) >> 4;
    mulawTable[i] = ((u & 0x80) ? 0x84 - m : m - 0x84) / 32768;
  }
}

function encodeAlaw(sample) {
  let v = sample >> 3;
  let mask;
  if (v >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    v = -v - 1;
  }
  let seg = 0;
  const ends = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  while (seg < 8 && v > ends[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (v >> 1) & 0x0f : (v >> seg) & 0x0f;
  return aval ^ mask;
}

function encodeMulaw(sample) {
  let v = sample;
  let sign = 0;
  if (v < 0) {
    v = -v;
    sign = 0x80;
  }
  if (v > 32635) v = 32635;
  v += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (v >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function isPcm(codec) {
  return Object.prototype.hasOwnProperty.call(formats, codec);
}

class PcmDecoder {
  constructor(stream) {
    if (!isPcm(stream.codec)) throw noSupport('not a pcm codec: ' + stream.codec);
    this.codec = stream.codec;
    this.channels = stream.channels;
    this.bytes = formats[stream.codec].bytes;
    this.out = new Float64Array(0);
    if (!alawTable) buildTables();
  }

  decode(buf) {
    const total = Math.floor(buf.length / this.bytes);
    const frames = Math.floor(total / this.channels);
    const count = frames * this.channels;
    if (this.out.length < count) this.out = new Float64Array(count);
    const out = this.out;
    switch (this.codec) {
      case 'pcm_u8':
        for (let i = 0; i < count; i++) out[i] = (buf[i] - 128) / 128;
        break;
      case 'pcm_s16le':
        for (let i = 0, o = 0; i < count; i++, o += 2) out[i] = (((buf[o] | (buf[o + 1] << 8)) << 16) >> 16) / 32768;
        break;
      case 'pcm_s24le':
        for (let i = 0, o = 0; i < count; i++, o += 3) out[i] = (((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) >> 8) / 8388608;
        break;
      case 'pcm_s32le':
        for (let i = 0, o = 0; i < count; i++, o += 4) out[i] = buf.readInt32LE(o) / 2147483648;
        break;
      case 'pcm_f32le':
        for (let i = 0, o = 0; i < count; i++, o += 4) out[i] = buf.readFloatLE(o);
        break;
      case 'pcm_f64le':
        for (let i = 0, o = 0; i < count; i++, o += 8) out[i] = buf.readDoubleLE(o);
        break;
      case 'pcm_alaw':
        for (let i = 0; i < count; i++) out[i] = alawTable[buf[i]];
        break;
      case 'pcm_mulaw':
        for (let i = 0; i < count; i++) out[i] = mulawTable[buf[i]];
        break;
    }
    return { data: out, frames };
  }
}

class PcmEncoder {
  constructor(codec, channels) {
    if (!isPcm(codec)) throw noSupport('not a pcm codec: ' + codec);
    this.codec = codec;
    this.channels = channels;
    this.bytes = formats[codec].bytes;
  }

  encode(data, frames) {
    const count = frames * this.channels;
    const out = Buffer.allocUnsafe(count * this.bytes);
    switch (this.codec) {
      case 'pcm_u8':
        for (let i = 0; i < count; i++) {
          let v = Math.round(data[i] * 128) + 128;
          out[i] = v > 255 ? 255 : v < 0 ? 0 : v;
        }
        break;
      case 'pcm_s16le':
        for (let i = 0, o = 0; i < count; i++, o += 2) {
          let v = Math.round(data[i] * 32768);
          v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
          out[o] = v & 0xff;
          out[o + 1] = (v >> 8) & 0xff;
        }
        break;
      case 'pcm_s24le':
        for (let i = 0, o = 0; i < count; i++, o += 3) {
          let v = Math.round(data[i] * 8388608);
          v = v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
          out[o] = v & 0xff;
          out[o + 1] = (v >> 8) & 0xff;
          out[o + 2] = (v >> 16) & 0xff;
        }
        break;
      case 'pcm_s32le':
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          let v = Math.round(data[i] * 2147483648);
          v = v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : v;
          out.writeInt32LE(v, o);
        }
        break;
      case 'pcm_f32le':
        for (let i = 0, o = 0; i < count; i++, o += 4) out.writeFloatLE(data[i], o);
        break;
      case 'pcm_f64le':
        for (let i = 0, o = 0; i < count; i++, o += 8) out.writeDoubleLE(data[i], o);
        break;
      case 'pcm_alaw':
        for (let i = 0; i < count; i++) {
          let v = Math.round(data[i] * 32768);
          out[i] = encodeAlaw(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
        break;
      case 'pcm_mulaw':
        for (let i = 0; i < count; i++) {
          let v = Math.round(data[i] * 32768);
          out[i] = encodeMulaw(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
        break;
    }
    return out;
  }
}

function pcmCodecForBits(bits, float) {
  if (float) return bits > 32 ? 'pcm_f64le' : 'pcm_f32le';
  if (bits <= 8) return 'pcm_u8';
  if (bits <= 16) return 'pcm_s16le';
  if (bits <= 24) return 'pcm_s24le';
  return 'pcm_s32le';
}

export {
  formats,
  isPcm,
  PcmDecoder,
  PcmEncoder,
  pcmCodecForBits,
};
