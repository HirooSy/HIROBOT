import { badData, badArg, noSupport } from '../errors.js';
import { createGray, createYuv, createRgba, clamp8, toYuv, toGray } from './frame.js';

const huffSpec = {
  dcLuma: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  dcChroma: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  acLuma: { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125], vals: [1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250] },
  acChroma: { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119], vals: [0, 1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113, 19, 34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240, 21, 98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38, 39, 40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 226, 227, 228, 229, 230, 231, 232, 233, 234, 242, 243, 244, 245, 246, 247, 248, 249, 250] },
};

const zigzag = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const aan = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

const defaultIntraMatrix = [
  8, 16, 19, 22, 26, 27, 29, 34,
  16, 16, 22, 24, 27, 29, 34, 37,
  19, 22, 26, 27, 29, 34, 34, 38,
  22, 22, 26, 27, 29, 34, 37, 40,
  22, 26, 27, 29, 32, 35, 40, 48,
  26, 27, 29, 32, 35, 40, 48, 58,
  26, 27, 29, 34, 38, 46, 56, 69,
  27, 29, 35, 38, 46, 56, 69, 83,
];

const stdLumaQuant = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const stdChromaQuant = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

function buildDecodeTable(counts, symbols) {
  const lookup = new Int16Array(512).fill(-1);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(18);
  const mincode = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    const n = counts[len - 1];
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= 9) {
        const base = code << (9 - len);
        const span = 1 << (9 - len);
        for (let j = 0; j < span; j++) lookup[base + j] = (len << 8) | symbols[k];
      }
    }
    maxcode[len] = n ? code - 1 : -1;
    code <<= 1;
  }
  return { lookup, maxcode, valptr, mincode, symbols };
}

class BitReader {
  constructor(data, pos) {
    this.data = data;
    this.pos = pos;
    this.bits = 0;
    this.cnt = 0;
    this.marker = 0;
  }

  fill() {
    const data = this.data;
    while (this.cnt <= 24) {
      let b = 0;
      if (!this.marker && this.pos < data.length) {
        b = data[this.pos++];
        if (b === 0xff) {
          let n = data[this.pos];
          while (n === 0xff) {
            this.pos++;
            n = data[this.pos];
          }
          if (n === 0) this.pos++;
          else {
            this.marker = n === undefined ? 0xd9 : n;
            this.pos--;
            b = 0;
          }
        }
      }
      this.bits = (this.bits | (b << (24 - this.cnt))) >>> 0;
      this.cnt += 8;
    }
  }

  receive(n) {
    if (n === 0) return 0;
    if (this.cnt < n) this.fill();
    const v = this.bits >>> (32 - n);
    this.bits = (this.bits << n) >>> 0;
    this.cnt -= n;
    return v;
  }

  receiveExtend(n) {
    const v = this.receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(table) {
    if (this.cnt < 16) this.fill();
    const look = table.lookup[this.bits >>> 23];
    if (look >= 0) {
      const len = look >> 8;
      this.bits = (this.bits << len) >>> 0;
      this.cnt -= len;
      return look & 255;
    }
    for (let len = 10; len <= 16; len++) {
      const code = this.bits >>> (32 - len);
      if (table.maxcode[len] >= 0 && code <= table.maxcode[len] && code >= table.mincode[len]) {
        this.bits = (this.bits << len) >>> 0;
        this.cnt -= len;
        return table.symbols[table.valptr[len] + code - table.mincode[len]];
      }
    }
    throw badData('invalid huffman code');
  }

  restart() {
    this.bits = 0;
    this.cnt = 0;
    if (!this.marker) {
      const d = this.data;
      let p = this.pos;
      while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] !== 0 && d[p + 1] !== 0xff)) p++;
      this.pos = p;
      this.marker = p + 1 < d.length ? d[p + 1] : 0xd9;
    }
    if (this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.pos += 2;
      this.marker = 0;
    }
  }
}

function idctBlock(coef, off, qt, out, outOff, stride, ws) {
  for (let c = 0; c < 8; c++) {
    const i = off + c;
    const t0 = coef[i] * qt[c];
    const x1 = coef[i + 8];
    const x2 = coef[i + 16];
    const x3 = coef[i + 24];
    const x4 = coef[i + 32];
    const x5 = coef[i + 40];
    const x6 = coef[i + 48];
    const x7 = coef[i + 56];
    if ((x1 | x2 | x3 | x4 | x5 | x6 | x7) === 0) {
      ws[c] = ws[c + 8] = ws[c + 16] = ws[c + 24] = ws[c + 32] = ws[c + 40] = ws[c + 48] = ws[c + 56] = t0;
      continue;
    }
    const t2 = x2 * qt[c + 16];
    const t4 = x4 * qt[c + 32];
    const t6 = x6 * qt[c + 48];
    const t10 = t0 + t4;
    const t11 = t0 - t4;
    const t13 = t2 + t6;
    const t12 = (t2 - t6) * 1.414213562 - t13;
    const e0 = t10 + t13;
    const e3 = t10 - t13;
    const e1 = t11 + t12;
    const e2 = t11 - t12;
    const o4 = coef[i + 8] * qt[c + 8];
    const o5 = coef[i + 24] * qt[c + 24];
    const o6 = coef[i + 40] * qt[c + 40];
    const o7 = coef[i + 56] * qt[c + 56];
    const z13 = o6 + o5;
    const z10 = o6 - o5;
    const z11 = o4 + o7;
    const z12 = o4 - o7;
    const u7 = z11 + z13;
    const u11 = (z11 - z13) * 1.414213562;
    const z5 = (z10 + z12) * 1.847759065;
    const u10 = 1.0823922 * z12 - z5;
    const u12 = -2.61312593 * z10 + z5;
    const u6 = u12 - u7;
    const u5 = u11 - u6;
    const u4 = u10 + u5;
    ws[c] = e0 + u7;
    ws[c + 56] = e0 - u7;
    ws[c + 8] = e1 + u6;
    ws[c + 48] = e1 - u6;
    ws[c + 16] = e2 + u5;
    ws[c + 40] = e2 - u5;
    ws[c + 32] = e3 + u4;
    ws[c + 24] = e3 - u4;
  }
  for (let r = 0; r < 8; r++) {
    const w = r * 8;
    const t10 = ws[w] + ws[w + 4];
    const t11 = ws[w] - ws[w + 4];
    const t13 = ws[w + 2] + ws[w + 6];
    const t12 = (ws[w + 2] - ws[w + 6]) * 1.414213562 - t13;
    const e0 = t10 + t13;
    const e3 = t10 - t13;
    const e1 = t11 + t12;
    const e2 = t11 - t12;
    const z13 = ws[w + 5] + ws[w + 3];
    const z10 = ws[w + 5] - ws[w + 3];
    const z11 = ws[w + 1] + ws[w + 7];
    const z12 = ws[w + 1] - ws[w + 7];
    const u7 = z11 + z13;
    const u11 = (z11 - z13) * 1.414213562;
    const z5 = (z10 + z12) * 1.847759065;
    const u10 = 1.0823922 * z12 - z5;
    const u12 = -2.61312593 * z10 + z5;
    const u6 = u12 - u7;
    const u5 = u11 - u6;
    const u4 = u10 + u5;
    const o = outOff + r * stride;
    out[o] = clamp8(Math.round(e0 + u7 + 128));
    out[o + 7] = clamp8(Math.round(e0 - u7 + 128));
    out[o + 1] = clamp8(Math.round(e1 + u6 + 128));
    out[o + 6] = clamp8(Math.round(e1 - u6 + 128));
    out[o + 2] = clamp8(Math.round(e2 + u5 + 128));
    out[o + 5] = clamp8(Math.round(e2 - u5 + 128));
    out[o + 4] = clamp8(Math.round(e3 + u4 + 128));
    out[o + 3] = clamp8(Math.round(e3 - u4 + 128));
  }
}

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw badData('not a jpeg');
  const state = { quant: [], dc: [], ac: [], frame: null, restart: 0, adobe: -1, scans: 0, progressive: false };
  let pos = 2;
  let reader = null;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    while (buf[pos] === 0xff) pos++;
    const marker = buf[pos++];
    if (marker === undefined) break;
    if (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(pos);
    const body = pos + 2;
    const end = pos + len;
    if (end > buf.length) throw badData('truncated jpeg segment');
    if (marker === 0xdb) {
      let p = body;
      while (p < end) {
        const pq = buf[p] >> 4;
        const tq = buf[p] & 15;
        p++;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          t[zigzag[i]] = pq ? buf.readUInt16BE(p) : buf[p];
          p += pq ? 2 : 1;
        }
        state.quant[tq] = t;
      }
    } else if (marker === 0xc4) {
      let p = body;
      while (p < end) {
        const tc = buf[p] >> 4;
        const th = buf[p] & 15;
        p++;
        const counts = buf.subarray(p, p + 16);
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        p += 16;
        const table = buildDecodeTable(counts, buf.subarray(p, p + total));
        p += total;
        if (tc === 0) state.dc[th] = table;
        else state.ac[th] = table;
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (state.frame) throw badData('multiple frames');
      const precision = buf[body];
      if (precision !== 8) throw noSupport('jpeg precision ' + precision + ' is not supported');
      const height = buf.readUInt16BE(body + 1);
      const width = buf.readUInt16BE(body + 3);
      const n = buf[body + 5];
      if (!width || !height) throw badData('invalid jpeg size');
      const comps = [];
      for (let i = 0; i < n; i++) {
        const p = body + 6 + i * 3;
        comps.push({ id: buf[p], h: buf[p + 1] >> 4, v: buf[p + 1] & 15, tq: buf[p + 2] });
        if (!comps[i].h || !comps[i].v) throw badData('invalid sampling factors');
      }
      state.frame = { width, height, comps };
      state.progressive = marker === 0xc2;
    } else if (marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
      throw noSupport('unsupported jpeg coding process');
    } else if (marker === 0xdd) {
      state.restart = buf.readUInt16BE(body);
    } else if (marker === 0xee && len >= 14 && buf.toString('latin1', body, body + 5) === 'Adobe') {
      state.adobe = buf[body + 11];
    } else if (marker === 0xda) {
      if (!state.frame) throw badData('scan before frame');
      const frame = state.frame;
      if (!frame.ready) prepareFrame(frame, state.progressive);
      const ns = buf[body];
      const scanComps = [];
      for (let i = 0; i < ns; i++) {
        const cid = buf[body + 1 + i * 2];
        const tabs = buf[body + 2 + i * 2];
        const comp = frame.comps.find((c) => c.id === cid);
        if (!comp) throw badData('invalid scan component');
        comp.dcTable = state.dc[tabs >> 4];
        comp.acTable = state.ac[tabs & 15];
        scanComps.push(comp);
      }
      const ss = buf[body + 1 + ns * 2];
      const se = buf[body + 2 + ns * 2];
      const ah = buf[body + 3 + ns * 2] >> 4;
      const al = buf[body + 3 + ns * 2] & 15;
      reader = new BitReader(buf, end);
      decodeScan(frame, scanComps, state, ss, se, ah, al, reader);
      state.scans++;
      pos = reader.pos;
      if (reader.marker) pos = reader.pos;
      continue;
    }
    pos = end;
  }
  if (!state.frame || !state.scans) throw badData('no image data');
  return state;
}

function prepareFrame(frame, progressive) {
  let hmax = 1;
  let vmax = 1;
  for (const c of frame.comps) {
    hmax = Math.max(hmax, c.h);
    vmax = Math.max(vmax, c.v);
  }
  frame.hmax = hmax;
  frame.vmax = vmax;
  frame.mcusPerLine = Math.ceil(frame.width / (8 * hmax));
  frame.mcusPerColumn = Math.ceil(frame.height / (8 * vmax));
  for (const c of frame.comps) {
    c.width = Math.ceil((frame.width * c.h) / hmax);
    c.height = Math.ceil((frame.height * c.v) / vmax);
    c.blocksPerLine = Math.ceil(c.width / 8);
    c.blocksPerColumn = Math.ceil(c.height / 8);
    c.blocksPerLineForMcu = frame.mcusPerLine * c.h;
    c.blocksPerColumnForMcu = frame.mcusPerColumn * c.v;
    const size = c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64;
    if (size > 400 * 1024 * 1024) throw noSupport('jpeg is too large');
    c.coef = new Int16Array(size);
    c.pred = 0;
  }
  frame.progressive = progressive;
  frame.ready = true;
}

function decodeScan(frame, comps, state, ss, se, ah, al, reader) {
  const progressive = state.progressive;
  let eobrun = 0;
  const ri = state.restart;
  const decodeBlock = (comp, row, col) => {
    const off = (row * comp.blocksPerLineForMcu + col) * 64;
    const coef = comp.coef;
    if (!progressive) {
      const t = reader.decode(comp.dcTable);
      comp.pred += t === 0 ? 0 : reader.receiveExtend(t);
      coef[off] = comp.pred;
      let k = 1;
      while (k < 64) {
        const rs = reader.decode(comp.acTable);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        coef[off + zigzag[k]] = reader.receiveExtend(s);
        k++;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const t = reader.decode(comp.dcTable);
        comp.pred += t === 0 ? 0 : reader.receiveExtend(t);
        coef[off] = comp.pred * (1 << al);
      } else if (reader.receive(1)) coef[off] |= 1 << al;
      return;
    }
    if (ah === 0) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      let k = ss;
      while (k <= se) {
        const rs = reader.decode(comp.acTable);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = reader.receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        coef[off + zigzag[k]] = reader.receiveExtend(s) * (1 << al);
        k++;
      }
      return;
    }
    const p1 = 1 << al;
    const m1 = -1 << al;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(comp.acTable);
        let s = rs & 15;
        let r = rs >> 4;
        if (s) s = reader.receive(1) ? p1 : m1;
        else if (r !== 15) {
          eobrun = 1 << r;
          if (r) eobrun += reader.receive(r);
          break;
        }
        while (k <= se) {
          const idx = off + zigzag[k];
          const cur = coef[idx];
          if (cur !== 0) {
            if (reader.receive(1) && (cur & p1) === 0) coef[idx] = cur >= 0 ? cur + p1 : cur + m1;
          } else if (--r < 0) break;
          k++;
        }
        if (s && k <= 63) coef[off + zigzag[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const idx = off + zigzag[k];
        const cur = coef[idx];
        if (cur !== 0 && reader.receive(1) && (cur & p1) === 0) coef[idx] = cur >= 0 ? cur + p1 : cur + m1;
      }
      eobrun--;
    }
  };

  for (const c of comps) c.pred = 0;
  let total;
  if (comps.length === 1) total = comps[0].blocksPerLine * comps[0].blocksPerColumn;
  else total = frame.mcusPerLine * frame.mcusPerColumn;
  for (let mcu = 0; mcu < total; mcu++) {
    if (ri && mcu > 0 && mcu % ri === 0) {
      reader.restart();
      eobrun = 0;
      for (const c of comps) c.pred = 0;
    }
    if (reader.marker && reader.marker !== 0 && reader.cnt <= 0 && !(reader.marker >= 0xd0 && reader.marker <= 0xd7)) break;
    if (comps.length === 1) {
      const c = comps[0];
      decodeBlock(c, Math.floor(mcu / c.blocksPerLine), mcu % c.blocksPerLine);
    } else {
      const mr = Math.floor(mcu / frame.mcusPerLine);
      const mc = mcu % frame.mcusPerLine;
      for (const c of comps) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, mr * c.v + v, mc * c.h + h);
      }
    }
  }
}

function renderComponents(state) {
  const frame = state.frame;
  const ws = new Float32Array(64);
  for (const c of frame.comps) {
    const q = state.quant[c.tq];
    if (!q) throw badData('missing quantization table');
    const qt = new Float32Array(64);
    for (let i = 0; i < 64; i++) qt[i] = (q[i] * aan[i >> 3] * aan[i & 7]) / 8;
    const stride = c.blocksPerLineForMcu * 8;
    const full = new Uint8Array(stride * c.blocksPerColumnForMcu * 8);
    for (let by = 0; by < c.blocksPerColumn; by++) {
      for (let bx = 0; bx < c.blocksPerLine; bx++) {
        idctBlock(c.coef, (by * c.blocksPerLineForMcu + bx) * 64, qt, full, by * 8 * stride + bx * 8, stride, ws);
      }
    }
    if (stride === c.width) {
      c.plane = full.subarray(0, c.width * c.height);
    } else {
      const plane = new Uint8Array(c.width * c.height);
      for (let y = 0; y < c.height; y++) plane.set(full.subarray(y * stride, y * stride + c.width), y * c.width);
      c.plane = plane;
    }
    c.coef = null;
  }
}

function decodeJpeg(buf) {
  const state = parseJpeg(buf);
  renderComponents(state);
  const f = state.frame;
  const { width, height, comps } = f;
  if (comps.length === 1) {
    const out = createGray(width, height);
    out.planes[0].data.set(comps[0].plane);
    return out;
  }
  if (comps.length !== 3) throw noSupport('jpeg with ' + comps.length + ' components is not supported');
  const rgbStored = state.adobe === 0 || (comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42);
  if (rgbStored) {
    if (comps.some((c) => c.width !== width || c.height !== height)) throw noSupport('subsampled rgb jpeg is not supported');
    const out = createRgba(width, height);
    const d = out.planes[0].data;
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      d[j] = comps[0].plane[i];
      d[j + 1] = comps[1].plane[i];
      d[j + 2] = comps[2].plane[i];
      d[j + 3] = 255;
    }
    return out;
  }
  const hsub = f.hmax / comps[1].h;
  const vsub = f.vmax / comps[1].v;
  if (comps[0].h !== f.hmax || comps[0].v !== f.vmax || comps[2].h !== comps[1].h || comps[2].v !== comps[1].v || !Number.isInteger(hsub) || !Number.isInteger(vsub)) {
    throw noSupport('unsupported jpeg sampling layout');
  }
  const out = createYuv(width, height, hsub, vsub);
  out.planes[0].data.set(comps[0].plane);
  out.planes[1].data.set(comps[1].plane);
  out.planes[2].data.set(comps[2].plane);
  return out;
}

function probeJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    while (buf[pos] === 0xff) pos++;
    const marker = buf[pos++];
    if (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(pos);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(pos + 5), height: buf.readUInt16BE(pos + 3), components: buf[pos + 7] };
    }
    pos += len;
  }
  return null;
}

class BitWriter {
  constructor(capacity) {
    this.buf = Buffer.allocUnsafe(capacity);
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }

  ensure(extra) {
    if (this.pos + extra > this.buf.length) {
      const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.pos + extra));
      this.buf.copy(next, 0, 0, this.pos);
      this.buf = next;
    }
  }

  bytes(arr) {
    this.ensure(arr.length);
    for (let i = 0; i < arr.length; i++) this.buf[this.pos++] = arr[i];
  }

  put(code, size) {
    if (size === 0) return;
    this.acc = (this.acc << size) | (code & ((1 << size) - 1));
    this.n += size;
    this.ensure(8);
    while (this.n >= 8) {
      const b = (this.acc >>> (this.n - 8)) & 255;
      this.buf[this.pos++] = b;
      if (b === 0xff) this.buf[this.pos++] = 0;
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }

  flush() {
    if (this.n > 0) this.put(0x7f, 8 - this.n);
  }

  result() {
    return this.buf.subarray(0, this.pos);
  }
}

function buildEncodeTable(spec) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < spec.bits[len - 1]; i++, k++, c++) {
      code[spec.vals[k]] = c;
      size[spec.vals[k]] = len;
    }
    c <<= 1;
  }
  return { code, size };
}

function fdctBlock(d) {
  for (let r = 0; r < 8; r++) {
    const o = r * 8;
    const t0 = d[o] + d[o + 7];
    const t7 = d[o] - d[o + 7];
    const t1 = d[o + 1] + d[o + 6];
    const t6 = d[o + 1] - d[o + 6];
    const t2 = d[o + 2] + d[o + 5];
    const t5 = d[o + 2] - d[o + 5];
    const t3 = d[o + 3] + d[o + 4];
    const t4 = d[o + 3] - d[o + 4];
    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;
    d[o] = t10 + t11;
    d[o + 4] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[o + 2] = t13 + z1;
    d[o + 6] = t13 - z1;
    const u10 = t4 + t5;
    const u11 = t5 + t6;
    const u12 = t6 + t7;
    const z5 = (u10 - u12) * 0.382683433;
    const z2 = 0.5411961 * u10 + z5;
    const z4 = 1.306562965 * u12 + z5;
    const z3 = u11 * 0.707106781;
    const z11 = t7 + z3;
    const z13 = t7 - z3;
    d[o + 5] = z13 + z2;
    d[o + 3] = z13 - z2;
    d[o + 1] = z11 + z4;
    d[o + 7] = z11 - z4;
  }
  for (let c = 0; c < 8; c++) {
    const t0 = d[c] + d[c + 56];
    const t7 = d[c] - d[c + 56];
    const t1 = d[c + 8] + d[c + 48];
    const t6 = d[c + 8] - d[c + 48];
    const t2 = d[c + 16] + d[c + 40];
    const t5 = d[c + 16] - d[c + 40];
    const t3 = d[c + 24] + d[c + 32];
    const t4 = d[c + 24] - d[c + 32];
    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;
    d[c] = t10 + t11;
    d[c + 32] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[c + 16] = t13 + z1;
    d[c + 48] = t13 - z1;
    const u10 = t4 + t5;
    const u11 = t5 + t6;
    const u12 = t6 + t7;
    const z5 = (u10 - u12) * 0.382683433;
    const z2 = 0.5411961 * u10 + z5;
    const z4 = 1.306562965 * u12 + z5;
    const z3 = u11 * 0.707106781;
    const z11 = t7 + z3;
    const z13 = t7 - z3;
    d[c + 40] = z13 + z2;
    d[c + 24] = z13 - z2;
    d[c + 8] = z11 + z4;
    d[c + 56] = z11 - z4;
  }
}

function qualityTables(quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const mk = (std) => std.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  return { luma: mk(stdLumaQuant), chroma: mk(stdChromaQuant) };
}

function qscaleTables(qscale) {
  const q = Math.min(31, Math.max(1, qscale));
  const t = defaultIntraMatrix.map((v, i) => (i === 0 ? 8 : Math.min(255, (v * q) >> 3)));
  return { luma: t, chroma: t };
}

function optimalSpec(freqIn) {
  const freq = new Float64Array(257);
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
  freq[256] = 1;
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1;
    let v = Infinity;
    for (let i = 0; i <= 256; i++) {
      if (freq[i] && freq[i] <= v) {
        v = freq[i];
        c1 = i;
      }
    }
    let c2 = -1;
    v = Infinity;
    for (let i = 0; i <= 256; i++) {
      if (freq[i] && freq[i] <= v && i !== c1) {
        v = freq[i];
        c2 = i;
      }
    }
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) {
      c1 = others[c1];
      codesize[c1]++;
    }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) {
      c2 = others[c2];
      codesize[c2]++;
    }
  }
  const bits = new Int32Array(40);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 39; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let i = 16;
  while (bits[i] === 0) i--;
  bits[i]--;
  const vals = [];
  for (let len = 1; len <= 32; len++) {
    for (let sym = 0; sym < 256; sym++) if (codesize[sym] === len) vals.push(sym);
  }
  return { bits: Array.from(bits.subarray(1, 17)), vals };
}

function bitLength(v) {
  let n = 0;
  while (v) {
    n++;
    v >>= 1;
  }
  return n;
}

function encodeJpeg(frame, options = {}) {
  let source = frame;
  if (options.hsub && options.vsub) source = toYuv(frame, options.hsub, options.vsub);
  else if (frame.format === 'rgba') source = toYuv(frame, 1, 1);
  else if (frame.format === 'yuv' && !((frame.hsub === 1 || frame.hsub === 2) && (frame.vsub === 1 || frame.vsub === 2))) source = toYuv(frame, 2, 2);
  if (options.gray && source.format !== 'gray') source = toGray(source);
  const isGray = source.format === 'gray';
  if (!isGray && source.format !== 'yuv') throw badArg('unsupported frame for jpeg');
  const useQuality = options.quality !== undefined;
  const tables = useQuality ? qualityTables(options.quality) : qscaleTables(options.qscale === undefined ? 4 : Number(options.qscale));
  const bias = useQuality ? 0.5 : 0.375;
  const same = tables.luma.every((v, i) => v === tables.chroma[i]);
  const optimal = options.optimize !== false;
  const { width, height } = source;
  const hs = isGray ? 1 : source.hsub;
  const vs = isGray ? 1 : source.vsub;
  const nc = isGray ? 1 : 3;
  const mcusX = Math.ceil(width / (8 * hs));
  const mcusY = Math.ceil(height / (8 * vs));
  const blocksPerMcu = isGray ? 1 : hs * vs + 2;
  const total = mcusX * mcusY * blocksPerMcu;
  const coefs = new Int16Array(total * 64);

  const quantInv = (table) => {
    const t = new Float32Array(64);
    for (let i = 0; i < 64; i++) t[i] = 1 / (table[i] * aan[i >> 3] * aan[i & 7] * 8);
    return t;
  };
  const invLuma = quantInv(tables.luma);
  const invChroma = same ? invLuma : quantInv(tables.chroma);
  const block = new Float32Array(64);

  const quantizeBlock = (plane, bx, by, ci, outOff) => {
    const pw = plane.width;
    const ph = plane.height;
    const data = plane.data;
    for (let y = 0; y < 8; y++) {
      let yy = by * 8 + y;
      if (yy >= ph) yy = ph - 1;
      const row = yy * pw;
      for (let x = 0; x < 8; x++) {
        let xx = bx * 8 + x;
        if (xx >= pw) xx = pw - 1;
        block[y * 8 + x] = data[row + xx] - 128;
      }
    }
    fdctBlock(block);
    const inv = ci === 0 ? invLuma : invChroma;
    coefs[outOff] = Math.round(block[0] * inv[0]);
    for (let k = 1; k < 64; k++) {
      const idx = zigzag[k];
      const x = block[idx] * inv[idx];
      const a = Math.floor((x < 0 ? -x : x) + bias);
      coefs[outOff + k] = x < 0 ? -a : a;
    }
  };

  let bi = 0;
  const order = [];
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let v = 0; v < vs; v++) {
        for (let h = 0; h < hs; h++) {
          quantizeBlock(source.planes[0], mx * hs + h, my * vs + v, 0, bi * 64);
          order.push(0);
          bi++;
        }
      }
      if (!isGray) {
        quantizeBlock(source.planes[1], mx, my, 1, bi * 64);
        order.push(1);
        bi++;
        quantizeBlock(source.planes[2], mx, my, 2, bi * 64);
        order.push(2);
        bi++;
      }
    }
  }

  const walk = (visit) => {
    const preds = [0, 0, 0];
    for (let b = 0; b < total; b++) {
      const ci = order[b];
      const o = b * 64;
      const chroma = ci === 0 ? 0 : 1;
      const diff = coefs[o] - preds[ci];
      preds[ci] = coefs[o];
      visit.dc(chroma, bitLength(diff < 0 ? -diff : diff), diff);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = coefs[o + k];
        if (v === 0) {
          run++;
          continue;
        }
        while (run > 15) {
          visit.ac(chroma, 0xf0, 0, 0);
          run -= 16;
        }
        const nb = bitLength(v < 0 ? -v : v);
        visit.ac(chroma, (run << 4) | nb, v, nb);
        run = 0;
      }
      if (run > 0) visit.ac(chroma, 0, 0, 0);
    }
  };

  let spec = { dcLuma: huffSpec.dcLuma, dcChroma: huffSpec.dcChroma, acLuma: huffSpec.acLuma, acChroma: huffSpec.acChroma };
  if (optimal) {
    const f = { dc: [new Float64Array(256), new Float64Array(256)], ac: [new Float64Array(256), new Float64Array(256)] };
    walk({
      dc: (c, nb) => {
        f.dc[c][nb]++;
      },
      ac: (c, sym) => {
        f.ac[c][sym]++;
      },
    });
    spec = {
      dcLuma: optimalSpec(f.dc[0]),
      dcChroma: isGray ? huffSpec.dcChroma : optimalSpec(f.dc[1]),
      acLuma: optimalSpec(f.ac[0]),
      acChroma: isGray ? huffSpec.acChroma : optimalSpec(f.ac[1]),
    };
  }
  const enc = {
    dcLuma: buildEncodeTable(spec.dcLuma),
    dcChroma: buildEncodeTable(spec.dcChroma),
    acLuma: buildEncodeTable(spec.acLuma),
    acChroma: buildEncodeTable(spec.acChroma),
  };

  const out = new BitWriter(Math.max(4096, (width * height) >> 1));
  out.bytes([0xff, 0xd8]);
  out.bytes([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dqt = (id, table) => {
    const seg = [0xff, 0xdb, 0, 67, id];
    for (let i = 0; i < 64; i++) seg.push(table[zigzag[i]]);
    out.bytes(seg);
  };
  dqt(0, tables.luma);
  if (!isGray && !same) dqt(1, tables.chroma);
  const sof = [0xff, 0xc0, 0, 8 + nc * 3, 8, height >> 8, height & 255, width >> 8, width & 255, nc];
  sof.push(1, (hs << 4) | vs, 0);
  if (!isGray) sof.push(2, 0x11, same ? 0 : 1, 3, 0x11, same ? 0 : 1);
  out.bytes(sof);
  const dht = (cls, id, sp) => {
    out.bytes([0xff, 0xc4, 0, 19 + sp.vals.length, (cls << 4) | id]);
    out.bytes(sp.bits);
    out.bytes(sp.vals);
  };
  dht(0, 0, spec.dcLuma);
  dht(1, 0, spec.acLuma);
  if (!isGray) {
    dht(0, 1, spec.dcChroma);
    dht(1, 1, spec.acChroma);
  }
  const sos = [0xff, 0xda, 0, 6 + nc * 2, nc, 1, 0x00];
  if (!isGray) sos.push(2, 0x11, 3, 0x11);
  sos.push(0, 63, 0);
  out.bytes(sos);

  walk({
    dc: (c, nb, diff) => {
      const t = c === 0 ? enc.dcLuma : enc.dcChroma;
      out.put(t.code[nb], t.size[nb]);
      if (nb) out.put(diff < 0 ? diff - 1 : diff, nb);
    },
    ac: (c, sym, v, nb) => {
      const t = c === 0 ? enc.acLuma : enc.acChroma;
      out.put(t.code[sym], t.size[sym]);
      if (nb) out.put(v < 0 ? v - 1 : v, nb);
    },
  });
  out.flush();
  out.bytes([0xff, 0xd9]);
  return Buffer.from(out.result());
}

export { decodeJpeg, encodeJpeg, probeJpeg };
