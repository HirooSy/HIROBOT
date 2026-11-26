import { badData } from '../errors.js';
import { parseAdtsHeader } from './adts.js';
import { splitAnnexB, parseSps, buildAvcC, buildAvc1Entry, annexBToAvcc, buildAsc } from '../bsf.js';

const clock = 90000;
const wrap33 = 8589934592;
const sizes = [188, 192, 204];

function readTs(b, o) {
  return (b[o] >> 1 & 7) * 1073741824 + b[o + 1] * 4194304 + (b[o + 2] >> 1) * 32768 + b[o + 3] * 128 + (b[o + 4] >> 1);
}

function detectLayout(buf) {
  for (const size of sizes) {
    const lead = size === 192 ? 4 : 0;
    for (let start = 0; start < Math.min(size, buf.length); start++) {
      let ok = true;
      for (let k = 0; k < 4 && ok; k++) {
        const p = start + lead + k * size;
        if (p >= buf.length) {
          ok = k >= 2;
          break;
        }
        if (buf[p] !== 0x47) ok = false;
      }
      if (ok) return { size, lead, start };
    }
  }
  return null;
}

class PesParser {
  constructor(layout, onPes) {
    this.layout = layout;
    this.onPes = onPes;
    this.pat = new Map();
    this.pmtPid = -1;
    this.es = [];
    this.pmtDone = false;
    this.acc = new Map();
  }

  feed(buf) {
    const { size, lead } = this.layout;
    for (let o = 0; o + size <= buf.length; o += size) {
      const p = o + lead;
      if (buf[p] !== 0x47) continue;
      const pusi = (buf[p + 1] & 0x40) !== 0;
      const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      const afc = (buf[p + 3] >> 4) & 3;
      let start = p + 4;
      if (afc & 2) start += 1 + buf[p + 4];
      if (!(afc & 1) || start >= p + 188) continue;
      const payload = buf.subarray(start, p + 188);
      if (pid === 0) this.section(payload, pusi, 'pat');
      else if (pid === this.pmtPid) this.section(payload, pusi, 'pmt');
      else if (this.es.some((e) => e.pid === pid)) this.collect(pid, payload, pusi);
    }
  }

  section(payload, pusi, kind) {
    if (!pusi || !payload.length) return;
    const sec = payload.subarray(1 + payload[0]);
    if (sec.length < 8) return;
    const len = ((sec[1] & 0x0f) << 8) | sec[2];
    const end = Math.min(sec.length, 3 + len - 4);
    if (kind === 'pat') {
      if (this.pmtPid >= 0) return;
      for (let i = 8; i + 4 <= end; i += 4) {
        const program = (sec[i] << 8) | sec[i + 1];
        if (program !== 0) {
          this.pmtPid = ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
          return;
        }
      }
      return;
    }
    if (this.pmtDone || sec[0] !== 2) return;
    const infoLen = ((sec[10] & 0x0f) << 8) | sec[11];
    let i = 12 + infoLen;
    const es = [];
    while (i + 5 <= end) {
      es.push({ type: sec[i], pid: ((sec[i + 1] & 0x1f) << 8) | sec[i + 2] });
      i += 5 + (((sec[i + 3] & 0x0f) << 8) | sec[i + 4]);
    }
    this.es = es.filter((e) => e.type === 0x1b || e.type === 0x0f);
    this.pmtDone = true;
  }

  collect(pid, payload, pusi) {
    let a = this.acc.get(pid);
    if (pusi) {
      if (a && a.parts.length) this.flushPid(pid);
      a = { parts: [], bytes: 0 };
      this.acc.set(pid, a);
    }
    if (!a) return;
    a.parts.push(payload);
    a.bytes += payload.length;
  }

  flushPid(pid) {
    const a = this.acc.get(pid);
    if (!a || !a.parts.length) return;
    const buf = a.parts.length === 1 ? a.parts[0] : Buffer.concat(a.parts);
    a.parts = [];
    a.bytes = 0;
    if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) return;
    const flags = buf[7] >> 6;
    const hdr = buf[8];
    let pts;
    let dts;
    if ((flags & 2) && buf.length >= 14) pts = readTs(buf, 9);
    if (flags === 3 && buf.length >= 19) dts = readTs(buf, 14);
    if (dts === undefined) dts = pts;
    this.onPes(pid, pts, dts, buf.subarray(9 + hdr));
  }

  flushAll() {
    for (const pid of this.acc.keys()) this.flushPid(pid);
  }
}

class TsDemuxer {
  static probe(head) {
    return head.length >= 5 && (head[0] === 0x47 || (head[4] === 0x47 && head[0] !== 0x47));
  }

  static async open(reader) {
    const demuxer = new TsDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'mpegts';
    this.tags = {};
    this.streams = [];
    this.duration = 0;
    this.queue = [];
    this.byPid = new Map();
    this.pending = new Map();
    this.ended = false;
  }

  makeTrack(pid, type) {
    let t = this.byPid.get(pid);
    if (!t) {
      t = { pid, type, stream: null, lastPts: -1, unwrap: 0, nextAudioPts: null, carry: null, sps: [], pps: [], firstTs: undefined, lastDelta: 3003, frames: [] };
      this.byPid.set(pid, t);
    }
    return t;
  }

  unwrapTs(t, v) {
    if (v === undefined) return v;
    if (t.lastRaw !== undefined && v - t.lastRaw < -wrap33 / 2) t.unwrap += wrap33;
    else if (t.lastRaw !== undefined && v - t.lastRaw > wrap33 / 2) t.unwrap -= wrap33;
    t.lastRaw = v;
    return v + t.unwrap;
  }

  async init() {
    const r = this.reader;
    r.seek(0);
    const head = await r.read(Math.min(r.size, 188 * 8));
    const layout = detectLayout(head);
    if (!layout) throw badData('mpegts: no sync pattern');
    this.layout = layout;
    this.startPos = layout.start;
    const limit = Math.min(r.size, 6 * 1024 * 1024);
    const parser = new PesParser(layout, (pid, pts, dts, payload) => this.probePes(pid, pts, dts, payload));
    this.probing = true;
    this.parserRef = parser;
    let pos = layout.start;
    const chunk = layout.size * 512;
    while (pos < limit) {
      r.seek(pos);
      const data = await r.read(Math.min(chunk, limit - pos));
      if (data.length < layout.size) break;
      const usable = data.length - (data.length % layout.size);
      parser.feed(data.subarray(0, usable));
      pos += usable;
      if (parser.pmtDone && this.ready(parser)) break;
    }
    parser.flushAll();
    this.probing = false;
    this.parserRef = null;
    if (!parser.pmtDone) throw badData('mpegts: no program map table');
    const tracks = parser.es.map((e) => this.byPid.get(e.pid)).filter((t) => t && t.stream);
    if (!tracks.length) throw badData('mpegts: no supported streams');
    let origin = Infinity;
    for (const t of tracks) if (t.firstTs !== undefined && t.firstTs < origin) origin = t.firstTs;
    this.origin = Number.isFinite(origin) ? origin : 0;
    tracks.forEach((t, i) => {
      t.stream.index = i;
      this.streams.push(t.stream);
    });
    for (const t of this.byPid.values()) {
      t.lastRaw = undefined;
      t.unwrap = 0;
      t.nextAudioPts = null;
      t.carry = null;
    }
    this.pos = layout.start;
  }

  ready(parser) {
    if (!parser.es.length) return false;
    for (const e of parser.es) {
      const t = this.byPid.get(e.pid);
      if (!t || !t.stream || t.firstTs === undefined) return false;
    }
    return true;
  }

  probePes(pid, pts, dts, payload) {
    const es = this.currentEs(pid);
    if (!es) return;
    const t = this.makeTrack(pid, es === 0x1b ? 'video' : 'audio');
    const stamp = this.unwrapTs(t, dts !== undefined ? dts : pts);
    if (t.type === 'video') {
      for (const nal of splitAnnexB(payload)) {
        const type = nal[0] & 31;
        if (type === 7 && !t.sps.some((s) => s.equals(nal))) t.sps.push(Buffer.from(nal));
        else if (type === 8 && !t.pps.some((s) => s.equals(nal))) t.pps.push(Buffer.from(nal));
      }
      if (!t.stream && t.sps.length && t.pps.length) {
        const info = parseSps(t.sps[0]);
        const avcC = buildAvcC(t.sps, t.pps, info);
        t.info = info;
        t.stream = { index: 0, type: 'video', codec: 'h264', timeScale: clock, width: info.width, height: info.height, extradata: avcC, mp4Entry: buildAvc1Entry(info.width, info.height, avcC), h264: info, duration: 0 };
      }
    } else if (!t.stream) {
      const h = this.findAdts(payload);
      if (h) {
        t.stream = { index: 0, type: 'audio', codec: 'aac', timeScale: h.sampleRate, sampleRate: h.sampleRate, channels: h.channels, extradata: buildAsc(h.profile, h.sfi, h.chan), duration: 0 };
      }
    }
    if (t.firstTs === undefined && stamp !== undefined) t.firstTs = stamp;
  }

  currentEs(pid) {
    const e = this.parserRef ? this.parserRef.es.find((x) => x.pid === pid) : null;
    return e ? e.type : 0;
  }

  findAdts(buf) {
    for (let i = 0; i + 7 <= buf.length; i++) {
      if (buf[i] !== 0xff) continue;
      const h = parseAdtsHeader(buf, i);
      if (h) return h;
    }
    return null;
  }

  emit(t, pkt) {
    if (t.type === 'video') {
      const prev = this.pending.get(t.pid);
      if (prev) {
        const delta = pkt.dts - prev.dts;
        prev.duration = delta > 0 ? delta : t.lastDelta;
        if (delta > 0) t.lastDelta = delta;
        this.queue.push(prev);
      }
      this.pending.set(t.pid, pkt);
    } else this.queue.push(pkt);
  }

  onPes(pid, pts, dts, payload) {
    const es = this.parser.es.find((x) => x.pid === pid);
    const t = this.byPid.get(pid);
    if (!es || !t || !t.stream) return;
    const rawDts = dts !== undefined ? dts : pts;
    if (rawDts === undefined && t.type === 'video') return;
    const uDts = this.unwrapTs(t, rawDts);
    const uPts = pts !== undefined && dts !== undefined && pts !== dts ? uDts + ((pts - dts + wrap33 * 2) % wrap33) : uDts;
    if (t.type === 'video') {
      const nals = splitAnnexB(payload);
      const keep = [];
      let key = false;
      let vcl = false;
      for (const nal of nals) {
        const type = nal[0] & 31;
        if (type === 9) continue;
        if (type === 7 || type === 8) {
          const known = (type === 7 ? t.sps : t.pps).some((s) => s.equals(nal));
          if (known) continue;
        }
        if (type >= 1 && type <= 5) vcl = true;
        if (type === 5) key = true;
        keep.push(nal);
      }
      if (!vcl) return;
      this.emit(t, { stream: t.stream.index, pts: uPts - this.origin, dts: uDts - this.origin, duration: t.lastDelta, key, data: annexBToAvcc(keep) });
      return;
    }
    let buf = payload;
    if (t.carry && t.carry.length) {
      buf = Buffer.concat([t.carry, payload]);
      t.carry = null;
    } else if (uDts !== undefined) t.nextAudioPts = ((uDts - this.origin) * t.stream.sampleRate) / clock;
    let o = 0;
    while (o + 7 <= buf.length) {
      const h = buf[o] === 0xff ? parseAdtsHeader(buf, o) : null;
      if (!h) {
        o++;
        continue;
      }
      if (o + h.frameLen > buf.length) break;
      const data = Buffer.from(buf.subarray(o + h.headerLen, o + h.frameLen));
      const frames = 1024 * h.blocks;
      const pos = Math.round(t.nextAudioPts === null ? 0 : t.nextAudioPts);
      this.queue.push({ stream: t.stream.index, pts: pos, dts: pos, duration: frames, key: true, data });
      t.nextAudioPts = (t.nextAudioPts === null ? 0 : t.nextAudioPts) + frames;
      o += h.frameLen;
    }
    if (o < buf.length) t.carry = Buffer.from(buf.subarray(o));
  }

  async readPacket() {
    const r = this.reader;
    if (!this.parser) {
      this.parser = new PesParser(this.layout, (pid, pts, dts, payload) => this.onPes(pid, pts, dts, payload));
      this.parser.es = [...this.byPid.values()].map((t) => ({ pid: t.pid, type: t.type === 'video' ? 0x1b : 0x0f }));
      this.parser.pmtDone = true;
      this.parser.pmtPid = -2;
    }
    for (;;) {
      if (this.queue.length) return this.queue.shift();
      if (this.ended) return null;
      r.seek(this.pos);
      const want = this.layout.size * 340;
      const data = await r.read(Math.min(want, r.size - this.pos));
      const usable = data.length - (data.length % this.layout.size);
      if (usable < this.layout.size) {
        this.ended = true;
        this.parser.flushAll();
        for (const p of this.pending.values()) this.queue.push(p);
        this.pending.clear();
        continue;
      }
      this.pos += usable;
      this.parser.feed(data.subarray(0, usable));
    }
  }

  async close() {
    await this.reader.close();
  }
}

export { TsDemuxer };
