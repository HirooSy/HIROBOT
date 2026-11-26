import { badData } from './errors.js';

function box(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.length;
  const out = Buffer.allocUnsafe(len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 'latin1');
  let o = 8;
  for (const p of parts) {
    Buffer.from(p.buffer, p.byteOffset, p.length).copy(out, o);
    o += p.length;
  }
  return out;
}

function findStartCodes(buf) {
  const starts = [];
  const n = buf.length;
  let i = 0;
  while (i + 3 <= n) {
    const j = buf.indexOf(0x01, i + 2);
    if (j < 0) break;
    if (buf[j - 1] === 0 && buf[j - 2] === 0) starts.push({ code: j - 2 > 0 && buf[j - 3] === 0 ? j - 3 : j - 2, data: j + 1 });
    i = j + 1;
  }
  return starts;
}

function splitAnnexB(buf) {
  const marks = findStartCodes(buf);
  const nals = [];
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].code : buf.length;
    let e = end;
    while (e > marks[k].data && buf[e - 1] === 0 && k + 1 >= marks.length) e--;
    if (e > marks[k].data) nals.push(buf.subarray(marks[k].data, e));
  }
  return nals;
}

function unescapeRbsp(nal) {
  const out = Buffer.allocUnsafe(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class RbspReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  bit() {
    const i = this.pos >> 3;
    if (i >= this.buf.length) throw badData('h264: sps overrun');
    const v = (this.buf[i] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw badData('h264: invalid exp-golomb');
    }
    return zeros === 0 ? 0 : Math.pow(2, zeros) - 1 + this.bits(zeros);
  }

  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function parseSps(nal) {
  const r = new RbspReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.bits(8);
  const compat = r.bits(8);
  const level = r.bits(8);
  r.ue();
  let chroma = 1;
  let depthLuma = 8;
  let depthChroma = 8;
  if (highProfiles.has(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    depthLuma = 8 + r.ue();
    depthChroma = 8 + r.ue();
    r.bit();
    if (r.bit()) {
      const count = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  const refFrames = r.ue();
  r.bit();
  const wMbs = r.ue() + 1;
  const hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let cropL = 0;
  let cropR = 0;
  let cropT = 0;
  let cropB = 0;
  if (r.bit()) {
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
  const cropY = (2 - frameMbsOnly) * (chroma === 1 ? 2 : 1);
  const width = wMbs * 16 - cropX * (cropL + cropR);
  const height = (2 - frameMbsOnly) * hMapUnits * 16 - cropY * (cropT + cropB);
  return { profile, compat, level, chroma, bitDepth: Math.max(depthLuma, depthChroma), width, height, refFrames, frameMbsOnly };
}

function buildAvcC(sps, pps, info) {
  const parts = [Buffer.from([1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length])];
  for (const s of sps) parts.push(Buffer.from([s.length >> 8, s.length & 255]), s);
  parts.push(Buffer.from([pps.length]));
  for (const p of pps) parts.push(Buffer.from([p.length >> 8, p.length & 255]), p);
  if (highProfiles.has(info.profile)) parts.push(Buffer.from([0xfc | info.chroma, 0xf8 | (info.bitDepth - 8), 0xf8 | (info.bitDepth - 8), 0]));
  return Buffer.concat(parts);
}

function buildAvc1Entry(width, height, avcC) {
  const head = Buffer.alloc(78);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(width, 24);
  head.writeUInt16BE(height, 26);
  head.writeUInt32BE(0x00480000, 28);
  head.writeUInt32BE(0x00480000, 32);
  head.writeUInt16BE(1, 40);
  head.writeUInt16BE(0x0018, 74);
  head.writeInt16BE(-1, 76);
  return box('avc1', head, box('avcC', avcC));
}

function annexBToAvcc(nals) {
  let total = 0;
  for (const n of nals) total += n.length + 4;
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  for (const n of nals) {
    out.writeUInt32BE(n.length, o);
    n.copy(out, o + 4);
    o += n.length + 4;
  }
  return out;
}

function parseAvcc(avcC) {
  if (avcC.length < 7 || avcC[0] !== 1) throw badData('h264: invalid avcC');
  const lengthSize = (avcC[4] & 3) + 1;
  const sps = [];
  const pps = [];
  let p = 6;
  for (let i = 0; i < (avcC[5] & 31); i++) {
    const n = avcC.readUInt16BE(p);
    sps.push(avcC.subarray(p + 2, p + 2 + n));
    p += 2 + n;
  }
  const np = avcC[p++];
  for (let i = 0; i < np; i++) {
    const n = avcC.readUInt16BE(p);
    pps.push(avcC.subarray(p + 2, p + 2 + n));
    p += 2 + n;
  }
  return { lengthSize, sps, pps };
}

function avccToAnnexB(data, lengthSize) {
  const parts = [];
  let p = 0;
  while (p + lengthSize <= data.length) {
    let n = 0;
    for (let i = 0; i < lengthSize; i++) n = n * 256 + data[p + i];
    p += lengthSize;
    if (n <= 0 || p + n > data.length) break;
    parts.push(Buffer.from([0, 0, 0, 1]), data.subarray(p, p + n));
    p += n;
  }
  return Buffer.concat(parts);
}

const aacRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function buildAsc(profile, sfi, chan) {
  const aot = profile + 1;
  return Buffer.from([(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (chan << 3)]);
}

function parseAsc(asc) {
  if (!asc || asc.length < 2) throw badData('aac: invalid AudioSpecificConfig');
  const aot = asc[0] >> 3;
  const sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const chan = (asc[1] >> 3) & 15;
  return { aot, sfi, sampleRate: aacRates[sfi], channels: [0, 1, 2, 3, 4, 5, 6, 8][chan] || 0, chan };
}

export { box, splitAnnexB, unescapeRbsp, parseSps, buildAvcC, buildAvc1Entry, annexBToAvcc, parseAvcc, avccToAnnexB, buildAsc, parseAsc, aacRates };
