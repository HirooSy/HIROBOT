import { BitReader, BitWriter } from '../bits.js';
import { crc8, crc16 } from '../crc.js';
import { badData, noSupport } from '../errors.js';

const blockSizes = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const flacRates = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, 0, 0, 0, 0];
const bpsTable = [0, 8, 12, 0, 16, 20, 24, 32];

function parseStreamInfo(buf, off = 0) {
  const minBlockSize = buf.readUInt16BE(off);
  const maxBlockSize = buf.readUInt16BE(off + 2);
  const minFrameSize = buf.readUIntBE(off + 4, 3);
  const maxFrameSize = buf.readUIntBE(off + 7, 3);
  const hi = buf.readUInt32BE(off + 10);
  const sampleRate = hi >>> 12;
  const channels = ((hi >>> 9) & 7) + 1;
  const bitsPerSample = (((hi >>> 4) & 31) + 1);
  const totalSamples = (hi & 15) * 4294967296 + buf.readUInt32BE(off + 14);
  return { minBlockSize, maxBlockSize, minFrameSize, maxFrameSize, sampleRate, channels, bitsPerSample, totalSamples };
}

function buildStreamInfo(info) {
  const buf = Buffer.alloc(34);
  buf.writeUInt16BE(info.minBlockSize, 0);
  buf.writeUInt16BE(info.maxBlockSize, 2);
  buf.writeUIntBE(info.minFrameSize || 0, 4, 3);
  buf.writeUIntBE(info.maxFrameSize || 0, 7, 3);
  const total = info.totalSamples || 0;
  const hi = ((info.sampleRate << 12) | ((info.channels - 1) << 9) | ((info.bitsPerSample - 1) << 4) | (Math.floor(total / 4294967296) & 15)) >>> 0;
  buf.writeUInt32BE(hi, 10);
  buf.writeUInt32BE(total >>> 0, 14);
  return buf;
}

function parseFrameHeader(buf, off, end, info) {
  if (off + 6 > end) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xfe) !== 0xf8) return null;
  const variable = buf[off + 1] & 1;
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];
  const bsCode = b2 >>> 4;
  const srCode = b2 & 15;
  const chAssign = b3 >>> 4;
  const bpsCode = (b3 >>> 1) & 7;
  if (b3 & 1) return null;
  if (bsCode === 0 || srCode === 15 || chAssign > 10 || bpsCode === 3) return null;
  let p = off + 4;
  const first = buf[p];
  let len;
  let value;
  if (first < 0x80) {
    len = 1;
    value = first;
  } else if (first < 0xc0) return null;
  else if (first < 0xe0) {
    len = 2;
    value = first & 0x1f;
  } else if (first < 0xf0) {
    len = 3;
    value = first & 0x0f;
  } else if (first < 0xf8) {
    len = 4;
    value = first & 0x07;
  } else if (first < 0xfc) {
    len = 5;
    value = first & 0x03;
  } else if (first < 0xfe) {
    len = 6;
    value = first & 0x01;
  } else if (first === 0xfe) {
    len = 7;
    value = 0;
  } else return null;
  if (p + len > end) return null;
  for (let i = 1; i < len; i++) {
    const c = buf[p + i];
    if ((c & 0xc0) !== 0x80) return null;
    value = value * 64 + (c & 0x3f);
  }
  p += len;
  let blockSize;
  if (bsCode === 6) {
    if (p + 1 > end) return null;
    blockSize = buf[p] + 1;
    p += 1;
  } else if (bsCode === 7) {
    if (p + 2 > end) return null;
    blockSize = buf.readUInt16BE(p) + 1;
    p += 2;
  } else blockSize = blockSizes[bsCode];
  let sampleRate;
  if (srCode === 12) {
    if (p + 1 > end) return null;
    sampleRate = buf[p] * 1000;
    p += 1;
  } else if (srCode === 13) {
    if (p + 2 > end) return null;
    sampleRate = buf.readUInt16BE(p);
    p += 2;
  } else if (srCode === 14) {
    if (p + 2 > end) return null;
    sampleRate = buf.readUInt16BE(p) * 10;
    p += 2;
  } else sampleRate = srCode === 0 ? (info ? info.sampleRate : 0) : flacRates[srCode];
  if (p + 1 > end) return null;
  if (crc8(buf, off, p) !== buf[p]) return null;
  const bps = bpsCode === 0 ? (info ? info.bitsPerSample : 0) : bpsTable[bpsCode];
  return {
    variable,
    number: value,
    blockSize,
    sampleRate,
    chAssign,
    channels: chAssign < 8 ? chAssign + 1 : 2,
    bps,
    headerLen: p + 1 - off,
  };
}

class FlacDecoder {
  constructor(stream) {
    if (!stream.extradata || stream.extradata.length < 34) throw badData('flac: missing streaminfo');
    this.info = parseStreamInfo(stream.extradata);
    if (this.info.bitsPerSample > 24) throw noSupport('flac: bit depth above 24 is not supported');
    this.channels = this.info.channels;
    this.chans = [];
    this.capacity = 0;
    this.out = new Float64Array(0);
  }

  ensure(blockSize) {
    if (blockSize <= this.capacity) return;
    this.capacity = blockSize;
    this.chans = [];
    for (let c = 0; c < 8; c++) this.chans.push(new Int32Array(blockSize));
  }

  decode(buf) {
    const hdr = parseFrameHeader(buf, 0, buf.length, this.info);
    if (!hdr) throw badData('flac: invalid frame header');
    if (hdr.bps > 24) throw noSupport('flac: bit depth above 24 is not supported');
    const n = hdr.blockSize;
    const ch = hdr.channels;
    this.ensure(n);
    const br = new BitReader(buf, hdr.headerLen, buf.length - 2);
    for (let c = 0; c < ch; c++) {
      let bps = hdr.bps;
      if ((hdr.chAssign === 8 && c === 1) || (hdr.chAssign === 9 && c === 0) || (hdr.chAssign === 10 && c === 1)) bps += 1;
      this.subframe(br, this.chans[c], n, bps);
    }
    const a = this.chans[0];
    const b = this.chans[1];
    if (hdr.chAssign === 8) for (let i = 0; i < n; i++) b[i] = a[i] - b[i];
    else if (hdr.chAssign === 9) for (let i = 0; i < n; i++) a[i] = a[i] + b[i];
    else if (hdr.chAssign === 10) {
      for (let i = 0; i < n; i++) {
        const side = b[i];
        const mid = (a[i] << 1) | (side & 1);
        a[i] = (mid + side) >> 1;
        b[i] = (mid - side) >> 1;
      }
    }
    if (this.out.length < n * ch) this.out = new Float64Array(n * ch);
    const out = this.out;
    const scale = 1 / Math.pow(2, hdr.bps - 1);
    for (let c = 0; c < ch; c++) {
      const src = this.chans[c];
      for (let i = 0, o = c; i < n; i++, o += ch) out[o] = src[i] * scale;
    }
    return { data: out, frames: n, channels: ch, sampleRate: hdr.sampleRate };
  }

  subframe(br, out, n, bps) {
    if (br.read(1) !== 0) throw badData('flac: invalid subframe');
    const type = br.read(6);
    let wasted = 0;
    if (br.read(1)) wasted = br.unary() + 1;
    const sbps = bps - wasted;
    if (type === 0) {
      const v = br.signed(sbps);
      for (let i = 0; i < n; i++) out[i] = v;
    } else if (type === 1) {
      for (let i = 0; i < n; i++) out[i] = br.signed(sbps);
    } else if (type >= 8 && type <= 12) {
      const order = type - 8;
      for (let i = 0; i < order; i++) out[i] = br.signed(sbps);
      this.residual(br, out, n, order);
      this.restoreFixed(out, n, order);
    } else if (type >= 32) {
      const order = type - 31;
      for (let i = 0; i < order; i++) out[i] = br.signed(sbps);
      const precision = br.read(4) + 1;
      if (precision === 16) throw badData('flac: invalid lpc precision');
      const shift = br.signed(5);
      if (shift < 0) throw badData('flac: invalid lpc shift');
      const coefs = new Float64Array(order);
      for (let i = 0; i < order; i++) coefs[i] = br.signed(precision);
      this.residual(br, out, n, order);
      const div = Math.pow(2, shift);
      for (let i = order; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < order; j++) sum += coefs[j] * out[i - 1 - j];
        out[i] += Math.floor(sum / div);
      }
    } else throw badData('flac: invalid subframe type');
    if (wasted) {
      const mul = Math.pow(2, wasted);
      for (let i = 0; i < n; i++) out[i] *= mul;
    }
  }

  residual(br, out, n, order) {
    const method = br.read(2);
    if (method > 1) throw badData('flac: invalid residual coding');
    const partOrder = br.read(4);
    const parts = 1 << partOrder;
    const paramBits = method === 0 ? 4 : 5;
    const escape = method === 0 ? 15 : 31;
    const per = n >> partOrder;
    if (per < order) throw badData('flac: invalid partition order');
    let idx = order;
    for (let p = 0; p < parts; p++) {
      const count = per - (p === 0 ? order : 0);
      const k = br.read(paramBits);
      if (k === escape) {
        const bits = br.read(5);
        for (let i = 0; i < count; i++) out[idx++] = bits ? br.signed(bits) : 0;
      } else if (k === 0) {
        for (let i = 0; i < count; i++) {
          const u = br.unary();
          out[idx++] = (u >>> 1) ^ -(u & 1);
        }
      } else {
        const mul = 1 << k;
        for (let i = 0; i < count; i++) {
          const u = br.unary() * mul + br.read(k);
          out[idx++] = (u >>> 1) ^ -(u & 1);
        }
      }
    }
  }

  restoreFixed(out, n, order) {
    switch (order) {
      case 1:
        for (let i = 1; i < n; i++) out[i] += out[i - 1];
        break;
      case 2:
        for (let i = 2; i < n; i++) out[i] += 2 * out[i - 1] - out[i - 2];
        break;
      case 3:
        for (let i = 3; i < n; i++) out[i] += 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3];
        break;
      case 4:
        for (let i = 4; i < n; i++) out[i] += 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4];
        break;
    }
  }
}

function utf8Number(value) {
  if (value < 0x80) return Buffer.from([value]);
  let len = 2;
  if (value >= 0x800) len = 3;
  if (value >= 0x10000) len = 4;
  if (value >= 0x200000) len = 5;
  if (value >= 0x4000000) len = 6;
  if (value >= 0x80000000) len = 7;
  const out = Buffer.alloc(len);
  let v = value;
  for (let i = len - 1; i > 0; i--) {
    out[i] = 0x80 | (v % 64);
    v = Math.floor(v / 64);
  }
  out[0] = len === 7 ? 0xfe : ((0xff << (8 - len)) & 0xff) | v;
  return out;
}

class FlacEncoder {
  constructor(options) {
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.bps = options.bitsPerSample;
    if (this.channels > 8) throw noSupport('flac: at most 8 channels');
    if (this.bps < 4 || this.bps > 24) throw noSupport('flac: bit depth must be between 4 and 24');
    this.blockSize = options.blockSize || (this.sampleRate >= 32000 ? 4096 : 1152);
    this.maxLpcOrder = options.maxLpcOrder === undefined ? 8 : options.maxLpcOrder;
    this.pending = [];
    for (let c = 0; c < this.channels; c++) this.pending.push(new Int32Array(this.blockSize));
    this.filled = 0;
    this.frameNumber = 0;
    this.samples = 0;
    this.minFrame = 0;
    this.maxFrame = 0;
    this.writer = new BitWriter(1 << 16);
    this.scratch = [];
    for (let i = 0; i < 4; i++) this.scratch.push(new Int32Array(this.blockSize + 8));
    this.work = {
      side: new Int32Array(this.blockSize),
      mid: new Int32Array(this.blockSize),
      resid: new Int32Array(this.blockSize),
      best: new Int32Array(this.blockSize),
      win: new Float64Array(this.blockSize),
      sig: new Float64Array(this.blockSize),
    };
    this.windowFor = 0;
    this.sums = new Float64Array(5);
    this.scale = Math.pow(2, this.bps - 1);
    this.max = this.scale - 1;
    this.min = -this.scale;
    this.extradata = buildStreamInfo({
      minBlockSize: this.blockSize,
      maxBlockSize: this.blockSize,
      minFrameSize: 0,
      maxFrameSize: 0,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bps,
      totalSamples: 0,
    });
  }

  push(data, frames) {
    const packets = [];
    let i = 0;
    const ch = this.channels;
    while (i < frames) {
      const take = Math.min(frames - i, this.blockSize - this.filled);
      for (let c = 0; c < ch; c++) {
        const dst = this.pending[c];
        let o = i * ch + c;
        for (let k = 0; k < take; k++, o += ch) {
          let v = Math.round(data[o] * this.scale);
          dst[this.filled + k] = v > this.max ? this.max : v < this.min ? this.min : v;
        }
      }
      this.filled += take;
      i += take;
      if (this.filled === this.blockSize) packets.push(this.encodeFrame(this.blockSize));
    }
    return packets;
  }

  flush() {
    const packets = [];
    if (this.filled > 0) packets.push(this.encodeFrame(this.filled));
    return packets;
  }

  streamInfo() {
    return {
      minBlockSize: this.blockSize,
      maxBlockSize: this.blockSize,
      minFrameSize: this.minFrame,
      maxFrameSize: this.maxFrame,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bps,
      totalSamples: this.samples,
    };
  }

  encodeFrame(n) {
    const w = this.writer;
    w.reset();
    const ch = this.channels;
    let assign = ch - 1;
    let signals = [];
    for (let c = 0; c < ch; c++) signals.push(this.pending[c].subarray(0, n));
    let bpsList = new Array(ch).fill(this.bps);
    if (ch === 2) {
      const sigLeft = signals[0];
      const sigRight = signals[1];
      const side = this.work.side.subarray(0, n);
      const mid = this.work.mid.subarray(0, n);
      for (let i = 0; i < n; i++) {
        side[i] = sigLeft[i] - sigRight[i];
        mid[i] = (sigLeft[i] + sigRight[i]) >> 1;
      }
      const eL = this.estimate(sigLeft);
      const eR = this.estimate(sigRight);
      const eS = this.estimate(side);
      const eM = this.estimate(mid);
      const best = Math.min(eL + eR, eL + eS, eS + eR, eM + eS);
      if (best === eL + eR) assign = 1;
      else if (best === eL + eS) {
        assign = 8;
        signals = [sigLeft, side];
        bpsList = [this.bps, this.bps + 1];
      } else if (best === eS + eR) {
        assign = 9;
        signals = [side, sigRight];
        bpsList = [this.bps + 1, this.bps];
      } else {
        assign = 10;
        signals = [mid, side];
        bpsList = [this.bps, this.bps + 1];
      }
    }
    const header = this.header(n, assign);
    const base = Buffer.from(header);
    for (let i = 0; i < base.length; i++) w.write(base[i], 8);
    for (let c = 0; c < ch; c++) this.subframe(signals[c], n, bpsList[c]);
    w.align();
    const body = w.bytes();
    const crc = crc16(body, 0, body.length);
    w.write(crc, 16);
    const frame = Buffer.from(w.bytes());
    const pts = this.samples;
    this.samples += n;
    this.frameNumber++;
    this.filled = 0;
    if (this.minFrame === 0 || frame.length < this.minFrame) this.minFrame = frame.length;
    if (frame.length > this.maxFrame) this.maxFrame = frame.length;
    return { pts, dts: pts, duration: n, key: true, data: frame };
  }

  header(n, assign) {
    const parts = [];
    let bsCode = 0;
    let extraBs = null;
    const idx = blockSizes.indexOf(n);
    if (idx > 0 && idx !== 6 && idx !== 7) bsCode = idx;
    else if (n <= 256) {
      bsCode = 6;
      extraBs = Buffer.from([n - 1]);
    } else {
      bsCode = 7;
      extraBs = Buffer.alloc(2);
      extraBs.writeUInt16BE(n - 1, 0);
    }
    let srCode = flacRates.indexOf(this.sampleRate);
    let extraSr = null;
    if (srCode <= 0) {
      if (this.sampleRate % 1000 === 0 && this.sampleRate / 1000 < 256) {
        srCode = 12;
        extraSr = Buffer.from([this.sampleRate / 1000]);
      } else if (this.sampleRate < 65536) {
        srCode = 13;
        extraSr = Buffer.alloc(2);
        extraSr.writeUInt16BE(this.sampleRate, 0);
      } else if (this.sampleRate % 10 === 0 && this.sampleRate / 10 < 65536) {
        srCode = 14;
        extraSr = Buffer.alloc(2);
        extraSr.writeUInt16BE(this.sampleRate / 10, 0);
      } else srCode = 0;
    }
    let bpsCode = bpsTable.indexOf(this.bps);
    if (bpsCode < 0) bpsCode = 0;
    parts.push(Buffer.from([0xff, 0xf8, (bsCode << 4) | srCode, (assign << 4) | (bpsCode << 1)]));
    parts.push(utf8Number(this.frameNumber));
    if (extraBs) parts.push(extraBs);
    if (extraSr) parts.push(extraSr);
    const head = Buffer.concat(parts);
    return Buffer.concat([head, Buffer.from([crc8(head, 0, head.length)])]);
  }

  orderSums(x, n, sums) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const d1 = v - prev;
      const d2 = d1 - p1;
      const d3 = d2 - p2;
      const d4 = d3 - p3;
      prev = v;
      p1 = d1;
      p2 = d2;
      p3 = d3;
      if (i >= 4) {
        s0 += v < 0 ? -v : v;
        s1 += d1 < 0 ? -d1 : d1;
        s2 += d2 < 0 ? -d2 : d2;
        s3 += d3 < 0 ? -d3 : d3;
        s4 += d4 < 0 ? -d4 : d4;
      }
    }
    sums[0] = s0;
    sums[1] = s1;
    sums[2] = s2;
    sums[3] = s3;
    sums[4] = s4;
    return Math.min(s0, s1, s2, s3, s4);
  }

  estimate(x) {
    return this.orderSums(x, x.length, this.sums);
  }

  subframe(x, n, bps) {
    const w = this.writer;
    let first = x[0];
    let constant = true;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (x[i] !== first) constant = false;
      acc |= x[i];
    }
    if (constant) {
      w.write(0, 1);
      w.write(0, 6);
      w.write(0, 1);
      w.write(first, bps);
      return;
    }
    let wasted = 0;
    if (acc !== 0) while (((acc >> wasted) & 1) === 0 && wasted < 24) wasted++;
    let sig = x;
    if (wasted > 0) {
      sig = this.scratch[3].subarray(0, n);
      for (let i = 0; i < n; i++) sig[i] = x[i] >> wasted;
    }
    const sbps = bps - wasted;
    let bestBits = n * sbps;
    let bestKind = 'verbatim';
    let bestOrder = 0;
    let bestLpc = null;
    let bestPlan = null;
    const rbuf = this.work.resid;
    if (n > 8) {
      this.orderSums(sig, n, this.sums);
      let order = 0;
      for (let o = 1; o <= 4; o++) if (this.sums[o] < this.sums[order]) order = o;
      this.fixedResidual(sig, n, order, rbuf);
      const plan = this.planRice(rbuf, n, order);
      const bits = order * sbps + plan.bits + 8;
      if (bits < bestBits) {
        bestBits = bits;
        bestKind = 'fixed';
        bestOrder = order;
        bestPlan = plan;
      }
    } else {
      const fixedMax = Math.min(4, n - 1);
      for (let order = 0; order <= fixedMax; order++) {
        this.fixedResidual(sig, n, order, rbuf);
        const plan = this.planRice(rbuf, n, order);
        const bits = order * sbps + plan.bits + 8;
        if (bits < bestBits) {
          bestBits = bits;
          bestKind = 'fixed';
          bestOrder = order;
          bestPlan = plan;
        }
      }
    }
    const maxOrder = Math.min(this.maxLpcOrder, n - 1);
    if (maxOrder >= 1 && n >= 32) {
      const lpc = this.lpcCandidates(sig, n, maxOrder, sbps);
      for (const cand of lpc) {
        this.lpcResidual(sig, n, cand, rbuf);
        const plan = this.planRice(rbuf, n, cand.order);
        const bits = cand.order * sbps + plan.bits + 9 + cand.precision * cand.order + 4 + 5 + 8;
        if (bits < bestBits) {
          bestBits = bits;
          bestKind = 'lpc';
          bestOrder = cand.order;
          bestLpc = cand;
          bestPlan = plan;
        }
      }
    }
    w.write(0, 1);
    const wasteFlag = wasted > 0 ? 1 : 0;
    if (bestKind === 'verbatim') {
      w.write(1, 6);
      w.write(wasteFlag, 1);
      if (wasteFlag) w.unary(wasted - 1);
      for (let i = 0; i < n; i++) w.write(sig[i], sbps);
      return;
    }
    if (bestKind === 'fixed') {
      w.write(8 + bestOrder, 6);
      w.write(wasteFlag, 1);
      if (wasteFlag) w.unary(wasted - 1);
      for (let i = 0; i < bestOrder; i++) w.write(sig[i], sbps);
      this.fixedResidual(sig, n, bestOrder, rbuf);
      this.writeResidual(rbuf, n, bestOrder, bestPlan);
      return;
    }
    w.write(31 + bestOrder, 6);
    w.write(wasteFlag, 1);
    if (wasteFlag) w.unary(wasted - 1);
    for (let i = 0; i < bestOrder; i++) w.write(sig[i], sbps);
    w.write(bestLpc.precision - 1, 4);
    w.write(bestLpc.shift, 5);
    for (let i = 0; i < bestOrder; i++) w.write(bestLpc.coefs[i], bestLpc.precision);
    this.lpcResidual(sig, n, bestLpc, rbuf);
    this.writeResidual(rbuf, n, bestOrder, bestPlan);
  }

  fixedResidual(x, n, order, out) {
    switch (order) {
      case 0:
        for (let i = 0; i < n; i++) out[i] = x[i];
        break;
      case 1:
        for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1];
        break;
      case 2:
        for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2];
        break;
      case 3:
        for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
        break;
      case 4:
        for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
        break;
    }
    return n - order;
  }

  lpcResidual(x, n, cand, out) {
    const order = cand.order;
    const coefs = cand.coefs;
    const div = Math.pow(2, cand.shift);
    for (let i = order; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += coefs[j] * x[i - 1 - j];
      out[i] = x[i] - Math.floor(sum / div);
    }
  }

  lpcCandidates(x, n, maxOrder, sbps) {
    const win = this.work.win;
    if (this.windowFor !== n) {
      const half = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        const t = (i - half) / (half + 1);
        win[i] = 1 - t * t;
      }
      this.windowFor = n;
    }
    const sig = this.work.sig;
    for (let i = 0; i < n; i++) sig[i] = x[i] * win[i];
    const ac = new Float64Array(maxOrder + 1);
    for (let lag = 0; lag <= maxOrder; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += sig[i] * sig[i - lag];
      ac[lag] = s;
    }
    if (ac[0] === 0) return [];
    ac[0] *= 1 + 1e-9;
    const lp = [];
    const errs = [];
    let a = new Float64Array(maxOrder + 1);
    let err = ac[0];
    for (let m = 1; m <= maxOrder; m++) {
      let acc = ac[m];
      for (let j = 1; j < m; j++) acc -= a[j] * ac[m - j];
      const k = acc / err;
      const next = new Float64Array(maxOrder + 1);
      for (let j = 1; j < m; j++) next[j] = a[j] - k * a[m - j];
      next[m] = k;
      a = next;
      err *= 1 - k * k;
      if (err <= 0) break;
      lp.push(Float64Array.from(a.subarray(1, m + 1)));
      errs.push(err);
    }
    if (!lp.length) return [];
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < lp.length; i++) {
      const order = i + 1;
      const bits = 0.5 * n * Math.log2(Math.max(errs[i] / n, 1e-9)) + order * 14;
      if (bits < bestScore) {
        bestScore = bits;
        bestIdx = i;
      }
    }
    const picks = new Set([bestIdx, lp.length - 1]);
    const out = [];
    for (const idx of picks) {
      const q = this.quantize(lp[idx], sbps);
      if (q) out.push(q);
    }
    return out;
  }

  quantize(lp, sbps) {
    const order = lp.length;
    const precision = sbps <= 16 ? 12 : 14;
    let cmax = 0;
    for (let i = 0; i < order; i++) cmax = Math.max(cmax, Math.abs(lp[i]));
    if (cmax <= 0) return null;
    const log2cmax = Math.floor(Math.log2(cmax)) + 1;
    let shift = precision - log2cmax - 1;
    if (shift > 15) shift = 15;
    if (shift < 0) return null;
    const lim = Math.pow(2, precision - 1);
    const coefs = new Int32Array(order);
    let error = 0;
    const mul = Math.pow(2, shift);
    for (let i = 0; i < order; i++) {
      error += lp[i] * mul;
      let q = Math.round(error);
      if (q > lim - 1) q = lim - 1;
      if (q < -lim) q = -lim;
      error -= q;
      coefs[i] = q;
    }
    return { order, precision, shift, coefs };
  }

  partSums(parts) {
    if (!this.partBuf) this.partBuf = new Float64Array(256);
    return this.partBuf;
  }

  planRice(res, n, order) {
    let maxPart = 0;
    while (maxPart < 8 && n % (1 << (maxPart + 1)) === 0 && (n >> (maxPart + 1)) > order) maxPart++;
    const parts = 1 << maxPart;
    const per = n >> maxPart;
    let sums = this.partSums(parts);
    let idx = order;
    for (let p = 0; p < parts; p++) {
      const count = per - (p === 0 ? order : 0);
      let s = 0;
      for (let i = 0; i < count; i++) {
        const r = res[idx++];
        s += r >= 0 ? r * 2 : -r * 2 - 1;
      }
      sums[p] = s;
    }
    let bestBits = Infinity;
    let bestOrder = 0;
    let level = maxPart;
    for (;;) {
      const cnt = 1 << level;
      const size = n >> level;
      let bits = 4 + 4 * cnt;
      for (let p = 0; p < cnt; p++) {
        const count = size - (p === 0 ? order : 0);
        const mean = count > 0 ? sums[p] / count : 0;
        const k = mean < 1 ? 0 : Math.min(30, 31 - Math.clz32(Math.floor(mean)));
        bits += count * (k + 1) + Math.floor(sums[p] / (1 << k));
      }
      if (bits < bestBits) {
        bestBits = bits;
        bestOrder = level;
      }
      if (level === 0) break;
      const half = 1 << (level - 1);
      for (let p = 0; p < half; p++) sums[p] = sums[2 * p] + sums[2 * p + 1];
      level--;
    }
    return { bits: bestBits + 2, order: bestOrder };
  }

  writeResidual(res, n, order, plan) {
    const w = this.writer;
    const level = plan.order;
    const cnt = 1 << level;
    const size = n >> level;
    const ks = new Int32Array(cnt);
    let big = false;
    let idx = order;
    for (let p = 0; p < cnt; p++) {
      const count = size - (p === 0 ? order : 0);
      let s = 0;
      for (let i = 0; i < count; i++) {
        const r = res[idx + i];
        s += r >= 0 ? r * 2 : -r * 2 - 1;
      }
      idx += count;
      const mean = count > 0 ? s / count : 0;
      const k = mean < 1 ? 0 : Math.min(30, 31 - Math.clz32(Math.floor(mean)));
      ks[p] = k;
      if (k > 14) big = true;
    }
    w.write(big ? 1 : 0, 2);
    w.write(level, 4);
    idx = order;
    for (let p = 0; p < cnt; p++) {
      const count = size - (p === 0 ? order : 0);
      w.write(ks[p], big ? 5 : 4);
      const k = ks[p];
      for (let i = 0; i < count; i++) w.rice(res[idx + i], k);
      idx += count;
    }
  }
}

export {
  parseStreamInfo,
  buildStreamInfo,
  parseFrameHeader,
  utf8Number,
  FlacDecoder,
  FlacEncoder,
};
