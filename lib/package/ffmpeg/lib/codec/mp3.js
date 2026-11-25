import * as tables from './mpa_tables.js';
import { parseMpaHeader } from './mpa.js';
import { BitReader } from '../bits.js';
import { badData } from '../errors.js';

const decoderDelay = 529;

let shared = null;

function buildTrie(entries) {
  let nodes = new Int32Array(1024);
  let count = 1;
  for (const [code, len, symbol] of entries) {
    let n = 0;
    for (let b = len - 1; b >= 0; b--) {
      const bit = Math.floor(code / Math.pow(2, b)) % 2;
      const slot = n * 2 + bit;
      if (b === 0) {
        nodes[slot] = -(symbol + 1);
      } else {
        if (nodes[slot] <= 0) {
          if (count * 2 + 2 > nodes.length) {
            const bigger = new Int32Array(nodes.length * 2);
            bigger.set(nodes);
            nodes = bigger;
          }
          nodes[slot] = count++;
        }
        n = nodes[slot];
      }
    }
  }
  return nodes;
}

const fastBits = 8;

function buildFast(entries) {
  const table = new Uint16Array(1 << fastBits);
  for (const [code, len, symbol] of entries) {
    if (len > fastBits) continue;
    const shift = fastBits - len;
    const base = code << shift;
    for (let i = 0; i < 1 << shift; i++) table[base + i] = (len << 9) | (symbol + 1);
  }
  return table;
}

function buildShared() {
  const huff = [null];
  const huffFast = [null];
  let off = 0;
  tables.huffSizes.forEach((size) => {
    const entries = [];
    let code = 0;
    for (let j = 0; j < size; j++) {
      const len = tables.huffLens[off + j];
      entries.push([Math.floor(code / Math.pow(2, 32 - len)), len, tables.huffSyms[off + j]]);
      code += Math.pow(2, 32 - len);
    }
    huff.push(buildTrie(entries));
    huffFast.push(buildFast(entries));
    off += size;
  });
  const quadEntries = [0, 1].map((t) => {
    const entries = [];
    for (let i = 0; i < 16; i++) entries.push([tables.quadCodes[t][i], tables.quadBits[t][i], i]);
    return entries;
  });
  const quadFast = quadEntries.map(buildFast);
  const pow43 = new Float64Array(8300);
  for (let i = 0; i < pow43.length; i++) pow43[i] = Math.pow(i, 4 / 3);
  const cos36 = new Float64Array(36 * 18);
  for (let i = 0; i < 36; i++) for (let k = 0; k < 18; k++) cos36[i * 18 + k] = Math.cos((Math.PI / 72) * (2 * i + 1 + 18) * (2 * k + 1));
  const cos12 = new Float64Array(12 * 6);
  for (let i = 0; i < 12; i++) for (let k = 0; k < 6; k++) cos12[i * 6 + k] = Math.cos((Math.PI / 24) * (2 * i + 1 + 6) * (2 * k + 1));
  const win = [new Float64Array(36), new Float64Array(36), new Float64Array(36), new Float64Array(36)];
  for (let i = 0; i < 36; i++) {
    win[0][i] = Math.sin((Math.PI / 36) * (i + 0.5));
    if (i < 18) win[1][i] = Math.sin((Math.PI / 36) * (i + 0.5));
    else if (i < 24) win[1][i] = 1;
    else if (i < 30) win[1][i] = Math.sin((Math.PI / 12) * (i - 18 + 0.5));
    else win[1][i] = 0;
    if (i < 6) win[3][i] = 0;
    else if (i < 12) win[3][i] = Math.sin((Math.PI / 12) * (i - 6 + 0.5));
    else if (i < 18) win[3][i] = 1;
    else win[3][i] = Math.sin((Math.PI / 36) * (i + 0.5));
  }
  const win12 = new Float64Array(12);
  for (let i = 0; i < 12; i++) win12[i] = Math.sin((Math.PI / 12) * (i + 0.5));
  const dwin = new Float64Array(512);
  for (let i = 0; i < 257; i++) {
    let v = tables.enWindow[i] / 65536;
    dwin[i] = v;
    if ((i & 63) !== 0) v = -v;
    if (i !== 0) dwin[512 - i] = v;
  }
  const ci = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
  const cs = ci.map((c) => 1 / Math.sqrt(1 + c * c));
  const ca = ci.map((c, i) => c * cs[i]);
  const isTable = [new Float64Array(16), new Float64Array(16)];
  for (let i = 0; i < 7; i++) {
    const v = i !== 6 ? Math.tan((i * Math.PI) / 12) / (1 + Math.tan((i * Math.PI) / 12)) : 1;
    isTable[0][i] = v;
    isTable[1][6 - i] = v;
  }
  const isLsf = [[new Float64Array(16), new Float64Array(16)], [new Float64Array(16), new Float64Array(16)]];
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 2; j++) {
      const e = -(j + 1) * ((i + 1) >> 1);
      const f = Math.pow(2, e / 4);
      const k = i & 1;
      isLsf[j][k ^ 1][i] = f;
      isLsf[j][k][i] = 1;
    }
  }
  const bandIndexLong = tables.bandLong.map((row) => {
    const out = [];
    let k = 0;
    for (let j = 0; j < 22; j++) {
      out.push(k);
      k += row[j] >> 1;
    }
    out.push(k);
    return out;
  });
  return { huff, huffFast, quadFast, pow43, cos36, cos12, win, win12, dwin, cs, ca, isTable, isLsf, bandIndexLong };
}

const dctSizes = [32, 16, 8, 4, 2];

function createDct32() {
  const tabs = dctSizes.map((dctLen) => {
    const t = new Float64Array(dctLen / 2);
    for (let i = 0; i < dctLen / 2; i++) t[i] = 1 / (2 * Math.cos(((2 * i + 1) * Math.PI) / (2 * dctLen)));
    return t;
  });
  const mk = () => dctSizes.map((dctLen) => new Float64Array(dctLen / 2));
  const a = mk();
  const b = mk();
  const ra = mk();
  const rb = mk();
  const rec = (l, x, out) => {
    const dctN = dctSizes[l];
    if (dctN === 2) {
      out[0] = x[0] + x[1];
      out[1] = (x[0] - x[1]) * Math.SQRT1_2;
      return;
    }
    const h = dctN / 2;
    const hiSums = a[l];
    const diffs = b[l];
    const t = tabs[l];
    for (let i = 0; i < h; i++) {
      hiSums[i] = x[i] + x[dctN - 1 - i];
      diffs[i] = (x[i] - x[dctN - 1 - i]) * t[i];
    }
    rec(l + 1, hiSums, ra[l]);
    rec(l + 1, diffs, rb[l]);
    const rbLevel = rb[l];
    for (let k = 0; k < h; k++) out[2 * k] = ra[l][k];
    for (let k = 0; k < h - 1; k++) out[2 * k + 1] = rbLevel[k] + rbLevel[k + 1];
    out[dctN - 1] = rbLevel[h - 1];
  };
  return (x, out) => rec(0, x, out);
}

function split(sf, n) {
  if (n >= 3 && n <= 6) {
    const m = Math.floor(sf / n);
    return [sf - m * n, m];
  }
  return [0, sf];
}

function newGranule() {
  return {
    part23: 0,
    bigValues: 0,
    globalGain: 0,
    scalefacCompress: 0,
    blockType: 0,
    switchPoint: 0,
    tableSelect: [0, 0, 0],
    subblockGain: [0, 0, 0],
    regionSize: [0, 0, 0],
    preflag: 0,
    scalefacScale: 0,
    count1Table: 0,
    scfsi: 0,
    sf: new Int32Array(48),
    longEnd: 22,
    shortStart: 13,
    xr: new Float64Array(576 + 8),
    is: new Int32Array(576 + 8),
  };
}

class Mp3Decoder {
  constructor(stream) {
    if (!shared) shared = buildShared();
    this.s = shared;
    this.reservoir = Buffer.alloc(0);
    this.gr = [[newGranule(), newGranule()], [newGranule(), newGranule()]];
    this.overlap = [new Float64Array(576), new Float64Array(576)];
    this.vbuf = [new Float64Array(1024), new Float64Array(1024)];
    this.voff = [0, 0];
    this.samples = new Float64Array(576);
    this.expo = new Float64Array(576);
    this.tmp = new Float64Array(576);
    this.sbs = new Float64Array(18 * 32);
    this.dct = createDct32();
    this.acc = new Float64Array(32);
    this.dctIn = new Float64Array(32);
    this.dctOut = new Float64Array(32);
    this.out = new Float64Array(0);
    this.spf = 0;
    const gap = stream && stream.gapless;
    this.skip = gap ? gap.delay + decoderDelay : 0;
    this.endLimit = gap && gap.frames > 0 ? gap.frames * (stream.samplesPerFrame || 1152) - gap.padding + decoderDelay : Infinity;
    this.index = 0;
  }

  static get preroll() {
    return 4;
  }

  decode(buf, pkt) {
    const hdr = parseMpaHeader(buf, 0);
    if (!hdr || hdr.layer !== 3) throw badData('mp3: invalid frame header');
    const sr = { 44100: 0, 48000: 1, 32000: 2, 22050: 3, 24000: 4, 16000: 5, 11025: 6, 12000: 7, 8000: 8 }[hdr.sampleRate];
    const lsf = !hdr.mpeg1;
    const nch = hdr.channels;
    const nGr = lsf ? 1 : 2;
    const jstereo = hdr.mode === 1;
    const modeExt = jstereo ? (hdr.b3 >> 4) & 3 : 0;
    const frames = nGr * 576;
    this.spf = frames;
    let pos = 4 + (hdr.protection ? 2 : 0);
    const sideLen = lsf ? (nch === 1 ? 9 : 17) : nch === 1 ? 17 : 32;
    if (buf.length < pos + sideLen) throw badData('mp3: truncated frame');
    const side = new BitReader(buf, pos, pos + sideLen);
    const mainStart = pos + sideLen;
    const mainBegin = side.read(lsf ? 8 : 9);
    side.read(lsf ? nch : nch === 2 ? 3 : 5);
    if (!lsf) {
      for (let c = 0; c < nch; c++) {
        this.gr[c][0].scfsi = 0;
        this.gr[c][1].scfsi = side.read(4);
      }
    }
    for (let g = 0; g < nGr; g++) {
      for (let c = 0; c < nch; c++) {
        const gr = this.gr[c][g];
        gr.part23 = side.read(12);
        gr.bigValues = side.read(9);
        gr.globalGain = side.read(8);
        if ((modeExt & 3) === 2) gr.globalGain -= 2;
        gr.scalefacCompress = side.read(lsf ? 9 : 4);
        const window = side.read(1);
        if (window) {
          gr.blockType = side.read(2);
          gr.switchPoint = side.read(1);
          gr.tableSelect[0] = side.read(5);
          gr.tableSelect[1] = side.read(5);
          gr.tableSelect[2] = 0;
          for (let i = 0; i < 3; i++) gr.subblockGain[i] = side.read(3);
          this.shortRegions(gr, sr);
        } else {
          gr.blockType = 0;
          gr.switchPoint = 0;
          for (let i = 0; i < 3; i++) gr.tableSelect[i] = side.read(5);
          const r1 = side.read(4);
          const r2 = side.read(3);
          const bi = this.s.bandIndexLong[sr];
          gr.regionSize[0] = bi[r1 + 1];
          gr.regionSize[1] = bi[Math.min(r1 + r2 + 2, 22)];
        }
        if (gr.bigValues > 288) throw badData('mp3: invalid big_values');
        let j = 0;
        gr.regionSize[2] = 288;
        for (let i = 0; i < 3; i++) {
          const k = Math.min(gr.regionSize[i], gr.bigValues);
          gr.regionSize[i] = k - j;
          j = k;
        }
        if (gr.blockType === 2) {
          if (gr.switchPoint) {
            gr.longEnd = sr <= 2 ? 8 : 6;
            gr.shortStart = 3;
          } else {
            gr.longEnd = 0;
            gr.shortStart = 0;
          }
        } else {
          gr.shortStart = 13;
          gr.longEnd = 22;
        }
        gr.preflag = lsf ? 0 : side.read(1);
        gr.scalefacScale = side.read(1);
        gr.count1Table = side.read(1);
      }
    }
    const own = buf.subarray(mainStart);
    const silent = this.reservoir.length < mainBegin;
    let main;
    if (silent) main = own;
    else main = mainBegin > 0 ? Buffer.concat([this.reservoir.subarray(this.reservoir.length - mainBegin), own]) : own;
    const merged = Buffer.concat([this.reservoir, own]);
    this.reservoir = merged.subarray(Math.max(0, merged.length - 511));
    const br = new BitReader(main, 0, main.length);
    let bitPos = 0;
    const out = this.out.length >= frames * nch ? this.out : (this.out = new Float64Array(frames * nch));
    for (let g = 0; g < nGr; g++) {
      for (let c = 0; c < nch; c++) {
        const gr = this.gr[c][g];
        gr.xr.fill(0);
        if (!silent) {
          try {
            br.pos = bitPos;
            br.limit = main.length * 8;
            this.readGranule(br, gr, g, c, lsf, sr, modeExt, bitPos + gr.part23, this.gr[c][0]);
          } catch (e) {
            gr.xr.fill(0);
          }
        }
        bitPos += gr.part23;
      }
      if (nch === 2 && jstereo) this.stereo(this.gr[0][g], this.gr[1][g], lsf, sr, modeExt);
      for (let c = 0; c < nch; c++) {
        const gr = this.gr[c][g];
        this.reorder(gr, sr);
        this.antialias(gr);
        this.imdct(gr, c);
        this.synth(c, g, out, nch);
      }
    }
    return this.trim(out, frames, nch, hdr.sampleRate, pkt);
  }

  trim(out, frames, nch, sampleRate, pkt) {
    const base = pkt ? (pkt.pts0 !== undefined ? pkt.pts0 : pkt.pts) : this.index * frames;
    this.index++;
    const from = Math.max(base, this.skip);
    const to = Math.min(base + frames, this.endLimit);
    if (to <= from) return { data: out, frames: 0, pts: 0, channels: nch, sampleRate };
    const a = from - base;
    const n = to - from;
    return { data: out.subarray(a * nch, (a + n) * nch), frames: n, pts: from - this.skip, channels: nch, sampleRate };
  }

  shortRegions(gr, sr) {
    if (gr.blockType === 2) gr.regionSize[0] = sr !== 8 ? 18 : 36;
    else if (sr <= 2) gr.regionSize[0] = 18;
    else gr.regionSize[0] = sr !== 8 ? 27 : 54;
    gr.regionSize[1] = 288;
  }

  readGranule(br, gr, g, c, lsf, sr, modeExt, endBits, gr0) {
    const sf = gr.sf;
    sf.fill(0);
    if (!lsf) {
      const slen1 = tables.slenTable[0][gr.scalefacCompress];
      const slen2 = tables.slenTable[1][gr.scalefacCompress];
      if (gr.blockType === 2) {
        const n = gr.switchPoint ? 17 : 18;
        let j = 0;
        for (let i = 0; i < n; i++) sf[j++] = slen1 ? br.read(slen1) : 0;
        for (let i = 0; i < 18; i++) sf[j++] = slen2 ? br.read(slen2) : 0;
      } else {
        let j = 0;
        for (let k = 0; k < 4; k++) {
          const n = k === 0 ? 6 : 5;
          if ((gr.scfsi & (8 >> k)) === 0) {
            const slen = k < 2 ? slen1 : slen2;
            for (let i = 0; i < n; i++) sf[j++] = slen ? br.read(slen) : 0;
          } else {
            for (let i = 0; i < n; i++) {
              sf[j] = gr0.sf[j];
              j++;
            }
          }
        }
      }
    } else {
      const tindex = gr.blockType === 2 ? (gr.switchPoint ? 2 : 1) : 0;
      let value = gr.scalefacCompress;
      const slen = [0, 0, 0, 0];
      let tindex2;
      const expand = (v, n1, n2, n3) => {
        let r;
        r = split(v, n3);
        slen[3] = r[0];
        v = r[1];
        r = split(v, n2);
        slen[2] = r[0];
        v = r[1];
        r = split(v, n1);
        slen[1] = r[0];
        v = r[1];
        slen[0] = v;
      };
      if (modeExt & 1 && c === 1) {
        value >>= 1;
        if (value < 180) {
          expand(value, 6, 6, 0);
          tindex2 = 3;
        } else if (value < 244) {
          expand(value - 180, 4, 4, 0);
          tindex2 = 4;
        } else {
          expand(value - 244, 3, 0, 0);
          tindex2 = 5;
        }
      } else if (value < 400) {
        expand(value, 5, 4, 4);
        tindex2 = 0;
      } else if (value < 500) {
        expand(value - 400, 5, 4, 0);
        tindex2 = 1;
      } else {
        expand(value - 500, 3, 0, 0);
        tindex2 = 2;
        gr.preflag = 1;
      }
      let j = 0;
      for (let k = 0; k < 4; k++) {
        const n = tables.lsfNsfTable[tindex2][tindex][k];
        const sl = slen[k];
        for (let i = 0; i < n; i++) sf[j++] = sl ? br.read(sl) : 0;
      }
    }
    this.exponents(gr, sr);
    this.huffman(br, gr, endBits);
  }

  exponents(gr, sr) {
    const expo = this.expo;
    const gain = gr.globalGain - 210;
    const shift = gr.scalefacScale + 1;
    const bl = tables.bandLong[sr];
    const pre = tables.pretabTable[gr.preflag];
    let p = 0;
    for (let i = 0; i < gr.longEnd; i++) {
      const v = Math.pow(2, (gain - ((gr.sf[i] + pre[i]) << shift)) / 4);
      for (let j = bl[i]; j > 0; j--) expo[p++] = v;
    }
    if (gr.shortStart < 13) {
      const bs = tables.bandShort[sr];
      const gains = [0, 1, 2].map((w) => gain - (gr.subblockGain[w] << 3));
      let k = gr.longEnd;
      for (let i = gr.shortStart; i < 13; i++) {
        for (let w = 0; w < 3; w++) {
          const v = Math.pow(2, (gains[w] - (gr.sf[k++] << shift)) / 4);
          for (let j = bs[i]; j > 0; j--) expo[p++] = v;
        }
      }
    }
    while (p < 576) expo[p++] = 0;
  }

  huffman(br, gr, endBits) {
    const s = this.s;
    const is = gr.is;
    const xr = gr.xr;
    const expo = this.expo;
    const pow43 = s.pow43;
    is.fill(0);
    let idx = 0;
    for (let r = 0; r < 3; r++) {
      let count = gr.regionSize[r];
      if (count === 0) continue;
      const entry = tables.huffData[gr.tableSelect[r]];
      const l = entry[0];
      const linbits = entry[1];
      if (!l) {
        idx += 2 * count;
        continue;
      }
      const trie = s.huff[l];
      const fast = s.huffFast[l];
      for (; count > 0; count--) {
        if (br.pos >= endBits) break;
        let sym;
        const f = fast[br.peek(fastBits)];
        if (f !== 0) {
          br.pos += f >> 9;
          sym = (f & 511) - 1;
        } else {
          let n = 0;
          do {
            n = trie[n * 2 + br.read(1)];
          } while (n > 0);
          if (n === 0) throw badData('mp3: invalid huffman code');
          sym = -n - 1;
        }
        let x = sym >> 4;
        let y = sym & 15;
        if (x === 15 && linbits) x += br.read(linbits);
        if (x !== 0 && br.read(1)) x = -x;
        if (y === 15 && linbits) y += br.read(linbits);
        if (y !== 0 && br.read(1)) y = -y;
        is[idx] = x;
        is[idx + 1] = y;
        idx += 2;
      }
    }
    const quadFast = s.quadFast[gr.count1Table];
    let last = -1;
    while (idx <= 572) {
      const at = br.pos;
      if (at >= endBits) {
        if (at > endBits && last >= 0) {
          idx -= 4;
          is[idx] = is[idx + 1] = is[idx + 2] = is[idx + 3] = 0;
        }
        break;
      }
      last = at;
      const qf = quadFast[br.peek(fastBits)];
      if (qf === 0) throw badData('mp3: invalid count1 code');
      br.pos += qf >> 9;
      const code = (qf & 511) - 1;
      for (let i = 0; i < 4; i++) {
        if (code & (8 >> i)) is[idx + i] = br.read(1) ? -1 : 1;
      }
      idx += 4;
    }
    for (let i = 0; i < 576; i++) {
      const v = is[i];
      if (v === 0) {
        xr[i] = 0;
        continue;
      }
      if (v > 8299 || v < -8299) throw badData('mp3: value out of range');
      xr[i] = (v > 0 ? pow43[v] : -pow43[-v]) * expo[i];
    }
  }

  stereo(g0, g1, lsf, sr, modeExt) {
    const t0 = g0.xr;
    const t1 = g1.xr;
    const sqrtHalf = Math.SQRT1_2;
    if (modeExt & 1) {
      const isTab = lsf ? this.s.isLsf[g1.scalefacCompress & 1] : this.s.isTable;
      const sfMax = lsf ? 16 : 7;
      const nz = [0, 0, 0];
      let p = 576;
      let k = (13 - g1.shortStart) * 3 + g1.longEnd - 3;
      const ms = (from, len) => {
        for (let j = 0; j < len; j++) {
          const a = t0[from + j];
          const b = t1[from + j];
          t0[from + j] = (a + b) * sqrtHalf;
          t1[from + j] = (a - b) * sqrtHalf;
        }
      };
      for (let i = 12; i >= g1.shortStart; i--) {
        if (i !== 11) k -= 3;
        const len = tables.bandShort[sr][i];
        for (let l = 2; l >= 0; l--) {
          p -= len;
          let found = nz[l] === 1;
          if (!found) {
            for (let j = 0; j < len; j++) {
              if (t1[p + j] !== 0) {
                nz[l] = 1;
                found = true;
                break;
              }
            }
            if (!found) {
              const sf = g1.sf[k + l];
              if (sf >= sfMax) found = true;
              else {
                const v1 = isTab[0][sf];
                const v2 = isTab[1][sf];
                for (let j = 0; j < len; j++) {
                  const a = t0[p + j];
                  t0[p + j] = a * v1;
                  t1[p + j] = a * v2;
                }
              }
            }
          }
          if (found && modeExt & 2) ms(p, len);
        }
      }
      let nonZero = nz[0] | nz[1] | nz[2];
      for (let i = g1.longEnd - 1; i >= 0; i--) {
        const len = tables.bandLong[sr][i];
        p -= len;
        let found = nonZero === 1;
        if (!found) {
          for (let j = 0; j < len; j++) {
            if (t1[p + j] !== 0) {
              nonZero = 1;
              found = true;
              break;
            }
          }
          if (!found) {
            const sf = g1.sf[i === 21 ? 20 : i];
            if (sf >= sfMax) found = true;
            else {
              const v1 = isTab[0][sf];
              const v2 = isTab[1][sf];
              for (let j = 0; j < len; j++) {
                const a = t0[p + j];
                t0[p + j] = a * v1;
                t1[p + j] = a * v2;
              }
            }
          }
        }
        if (found && modeExt & 2) ms(p, len);
      }
    } else if (modeExt & 2) {
      for (let i = 0; i < 576; i++) {
        const a = t0[i];
        const b = t1[i];
        t0[i] = a + b;
        t1[i] = a - b;
      }
    }
  }

  reorder(gr, sr) {
    if (gr.blockType !== 2) return;
    const xr = gr.xr;
    const tmp = this.tmp;
    let p = gr.switchPoint ? (sr !== 8 ? 36 : 72) : 0;
    for (let i = gr.shortStart; i < 13; i++) {
      const len = tables.bandShort[sr][i];
      let d = 0;
      for (let j = 0; j < len; j++) {
        tmp[d++] = xr[p + j];
        tmp[d++] = xr[p + len + j];
        tmp[d++] = xr[p + 2 * len + j];
      }
      for (let j = 0; j < len * 3; j++) xr[p + j] = tmp[j];
      p += len * 3;
    }
  }

  antialias(gr) {
    let n;
    if (gr.blockType === 2) {
      if (!gr.switchPoint) return;
      n = 1;
    } else n = 31;
    const xr = gr.xr;
    const cs = this.s.cs;
    const ca = this.s.ca;
    let base = 18;
    for (let i = 0; i < n; i++, base += 18) {
      for (let j = 0; j < 8; j++) {
        const a = xr[base - 1 - j];
        const b = xr[base + j];
        xr[base - 1 - j] = a * cs[j] - b * ca[j];
        xr[base + j] = b * cs[j] + a * ca[j];
      }
    }
  }

  imdct(gr, ch) {
    const s = this.s;
    const xr = gr.xr;
    const overlap = this.overlap[ch];
    const sbs = this.sbs;
    const y = this.imdctBuf || (this.imdctBuf = new Float64Array(36));
    for (let sb = 0; sb < 32; sb++) {
      const base = sb * 18;
      let any = false;
      for (let k = 0; k < 18; k++) {
        if (xr[base + k] !== 0) {
          any = true;
          break;
        }
      }
      const ob = sb * 18;
      if (!any) {
        for (let i = 0; i < 18; i++) {
          sbs[i * 32 + sb] = overlap[ob + i];
          overlap[ob + i] = 0;
        }
      } else {
        const short = gr.blockType === 2 && !(gr.switchPoint && sb < 2);
        if (!short) {
          const wt = gr.switchPoint && sb < 2 ? 0 : gr.blockType;
          const w = s.win[wt];
          for (let i = 0; i < 9; i++) {
            let lo = 0;
            let hi = 0;
            const r0 = i * 18;
            const r1 = (i + 18) * 18;
            for (let k = 0; k < 18; k++) {
              const x = xr[base + k];
              lo += x * s.cos36[r0 + k];
              hi += x * s.cos36[r1 + k];
            }
            y[i] = lo;
            y[17 - i] = -lo;
            y[18 + i] = hi;
            y[35 - i] = hi;
          }
          for (let i = 0; i < 36; i++) y[i] *= w[i];
        } else {
          y.fill(0);
          for (let w = 0; w < 3; w++) {
            for (let i = 0; i < 12; i++) {
              let sum = 0;
              const row = i * 6;
              for (let k = 0; k < 6; k++) sum += xr[base + 3 * k + w] * s.cos12[row + k];
              y[6 + 6 * w + i] += sum * s.win12[i];
            }
          }
        }
        for (let i = 0; i < 18; i++) {
          sbs[i * 32 + sb] = y[i] + overlap[ob + i];
          overlap[ob + i] = y[18 + i];
        }
      }
      if (sb & 1) for (let i = 1; i < 18; i += 2) sbs[i * 32 + sb] = -sbs[i * 32 + sb];
    }
  }

  synth(ch, g, out, nch) {
    const s = this.s;
    const v = this.vbuf[ch];
    const sbs = this.sbs;
    const dwin = s.dwin;
    const din = this.dctIn;
    const dout = this.dctOut;
    let off = this.voff[ch];
    for (let t = 0; t < 18; t++) {
      off = (off - 64) & 1023;
      const sb = t * 32;
      for (let k = 0; k < 32; k++) din[k] = sbs[sb + k];
      this.dct(din, dout);
      for (let i = 0; i < 64; i++) {
        const m = 16 + i;
        let val;
        if (m <= 31) val = dout[m];
        else if (m === 32) val = 0;
        else if (m <= 64) val = -dout[64 - m];
        else val = -dout[m - 64];
        v[(off + i) & 1023] = val;
      }
      const acc = this.acc;
      acc.fill(0);
      for (let m = 0; m < 8; m++) {
        const b1 = (off + 128 * m) & 1023;
        const b2 = (b1 + 96) & 1023;
        const d1 = 64 * m;
        const d2 = d1 + 32;
        for (let j = 0; j < 32; j++) acc[j] += v[b1 + j] * dwin[d1 + j] + v[b2 + j] * dwin[d2 + j];
      }
      const outBase = (g * 576 + t * 32) * nch + ch;
      for (let j = 0; j < 32; j++) out[outBase + j * nch] = acc[j];
    }
    this.voff[ch] = off;
  }
}

export {
  Mp3Decoder,
};
