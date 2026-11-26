import { badData } from '../errors.js';
import { buildAvc1Entry, parseSps, parseAvcc, box } from '../bsf.js';

const ids = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
  tags: 0x1254c367,
  seekHead: 0x114d9b74,
  chapters: 0x1043a770,
  attachments: 0x1941a469,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  title: 0x7ba9,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  bitDepth: 0x6264,
  codecDelay: 0x56aa,
  contentEncodings: 0x6d80,
  clusterTimecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  referenceBlock: 0xfb,
  docType: 0x4282,
};

const topLevel = new Set([ids.cluster, ids.cues, ids.tags, ids.seekHead, ids.chapters, ids.attachments, ids.info, ids.tracks]);

function vintLength(first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

function readId(buf, pos) {
  const len = vintLength(buf[pos]);
  if (!len || len > 4 || pos + len > buf.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return { id: v, len };
}

function readSize(buf, pos) {
  if (pos >= buf.length) return null;
  const len = vintLength(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  let v = buf[pos] & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) {
    v = v * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : v, len };
}

function readUint(buf) {
  let v = 0;
  for (let i = 0; i < buf.length; i++) v = v * 256 + buf[i];
  return v;
}

function readFloat(buf) {
  if (buf.length === 4) return buf.readFloatBE(0);
  if (buf.length === 8) return buf.readDoubleBE(0);
  return 0;
}

function parseChildren(buf, start, end, handler) {
  let p = start;
  while (p < end) {
    const id = readId(buf, p);
    if (!id) break;
    const sz = readSize(buf, p + id.len);
    if (!sz) break;
    const dataStart = p + id.len + sz.len;
    const dataEnd = sz.size < 0 ? end : Math.min(end, dataStart + sz.size);
    handler(id.id, dataStart, dataEnd);
    p = dataEnd;
  }
}

function hevcEntry(width, height, hvcC) {
  const head = Buffer.alloc(78);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(width, 24);
  head.writeUInt16BE(height, 26);
  head.writeUInt32BE(0x00480000, 28);
  head.writeUInt32BE(0x00480000, 32);
  head.writeUInt16BE(1, 40);
  head.writeUInt16BE(0x0018, 74);
  head.writeInt16BE(-1, 76);
  return box('hvc1', head, box('hvcC', hvcC));
}

function av1Entry(width, height, av1C) {
  const head = Buffer.alloc(78);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(width, 24);
  head.writeUInt16BE(height, 26);
  head.writeUInt32BE(0x00480000, 28);
  head.writeUInt32BE(0x00480000, 32);
  head.writeUInt16BE(1, 40);
  head.writeUInt16BE(0x0018, 74);
  head.writeInt16BE(-1, 76);
  return box('av01', head, box('av1C', av1C));
}

class Reorder {
  constructor(depth) {
    this.depth = depth;
    this.packets = [];
    this.heap = [];
    this.shift = null;
    this.warm = [];
    this.out = [];
  }

  pushHeap(v) {
    const h = this.heap;
    h.push(v);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= h[i]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }

  popHeap() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        let m = i;
        const l = 2 * i + 1;
        const r = l + 1;
        if (l < h.length && h[l] < h[m]) m = l;
        if (r < h.length && h[r] < h[m]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }

  push(pkt) {
    this.packets.push(pkt);
    this.pushHeap(pkt.pts);
    if (this.packets.length > this.depth) this.release();
  }

  release() {
    const pkt = this.packets.shift();
    pkt.dts = this.popHeap();
    this.out.push(pkt);
  }

  flush() {
    while (this.packets.length) this.release();
  }

  take() {
    return this.out.length ? this.out.shift() : null;
  }
}

class MatroskaDemuxer {
  static probe(head) {
    return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }

  static async open(reader) {
    const demuxer = new MatroskaDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'matroska';
    this.tags = {};
    this.streams = [];
    this.duration = 0;
    this.scale = 1000000;
    this.tracks = new Map();
    this.queue = [];
    this.pos = 0;
    this.cluster = null;
    this.ended = false;
  }

  async readHeader(pos) {
    const r = this.reader;
    r.seek(pos);
    const head = await r.read(12);
    if (head.length < 2) return null;
    const id = readId(head, 0);
    if (!id) return null;
    const sz = readSize(head, id.len);
    if (!sz) return null;
    return { id: id.id, size: sz.size, dataStart: pos + id.len + sz.len };
  }

  async init() {
    const r = this.reader;
    let h = await this.readHeader(0);
    if (!h || h.id !== ids.ebml) throw badData('matroska: missing EBML header');
    r.seek(h.dataStart);
    const ebml = await r.read(h.size);
    parseChildren(ebml, 0, ebml.length, (id, s, e) => {
      if (id === ids.docType) this.docType = ebml.toString('latin1', s, e);
    });
    this.format = this.docType === 'webm' ? 'webm' : 'matroska';
    let pos = h.dataStart + h.size;
    h = await this.readHeader(pos);
    if (!h || h.id !== ids.segment) throw badData('matroska: missing segment');
    this.segmentEnd = h.size < 0 ? r.size : Math.min(r.size, h.dataStart + h.size);
    pos = h.dataStart;
    let sawTracks = false;
    while (pos < this.segmentEnd) {
      h = await this.readHeader(pos);
      if (!h) break;
      if (h.id === ids.cluster) break;
      const end = h.size < 0 ? this.segmentEnd : h.dataStart + h.size;
      if (h.id === ids.info || h.id === ids.tracks) {
        r.seek(h.dataStart);
        const body = await r.read(end - h.dataStart);
        if (h.id === ids.info) this.parseInfo(body);
        else {
          this.parseTracks(body);
          sawTracks = true;
        }
      }
      pos = end;
    }
    if (!sawTracks || !this.streams.length) throw badData('matroska: no supported tracks');
    this.pos = pos;
  }

  parseInfo(buf) {
    let dur = 0;
    parseChildren(buf, 0, buf.length, (id, s, e) => {
      if (id === ids.timecodeScale) this.scale = readUint(buf.subarray(s, e)) || 1000000;
      else if (id === ids.duration) dur = readFloat(buf.subarray(s, e));
      else if (id === ids.title) this.tags.title = buf.toString('utf8', s, e);
    });
    this.duration = (dur * this.scale) / 1e9;
  }

  parseTracks(buf) {
    parseChildren(buf, 0, buf.length, (id, s, e) => {
      if (id !== ids.trackEntry) return;
      const t = { number: 0, type: 0, codecId: '', priv: null, width: 0, height: 0, rate: 0, channels: 0, bits: 0, delay: 0, defaultDuration: 0, compressed: false };
      parseChildren(buf, s, e, (cid, cs, ce) => {
        const d = buf.subarray(cs, ce);
        if (cid === ids.trackNumber) t.number = readUint(d);
        else if (cid === ids.trackType) t.type = readUint(d);
        else if (cid === ids.codecId) t.codecId = d.toString('latin1');
        else if (cid === ids.codecPrivate) t.priv = Buffer.from(d);
        else if (cid === ids.defaultDuration) t.defaultDuration = readUint(d);
        else if (cid === ids.codecDelay) t.delay = readUint(d);
        else if (cid === ids.contentEncodings) t.compressed = true;
        else if (cid === ids.video) {
          parseChildren(buf, cs, ce, (vid, vs, ve) => {
            if (vid === ids.pixelWidth) t.width = readUint(buf.subarray(vs, ve));
            else if (vid === ids.pixelHeight) t.height = readUint(buf.subarray(vs, ve));
          });
        } else if (cid === ids.audio) {
          parseChildren(buf, cs, ce, (aid, as, ae) => {
            if (aid === ids.samplingFrequency) t.rate = readFloat(buf.subarray(as, ae));
            else if (aid === ids.channels) t.channels = readUint(buf.subarray(as, ae));
            else if (aid === ids.bitDepth) t.bits = readUint(buf.subarray(as, ae));
          });
        }
      });
      this.addTrack(t);
    });
  }

  addTrack(t) {
    if (t.compressed) return;
    let stream = null;
    const c = t.codecId;
    if (t.type === 1) {
      stream = { index: 0, type: 'video', timeScale: 90000, width: t.width, height: t.height, duration: this.duration };
      if (c === 'V_MPEG4/ISO/AVC' && t.priv) {
        const avc = parseAvcc(t.priv);
        const info = avc.sps.length ? parseSps(avc.sps[0]) : null;
        stream.codec = 'h264';
        stream.extradata = t.priv;
        stream.nalLength = avc.lengthSize;
        stream.h264 = info;
        stream.mp4Entry = buildAvc1Entry(info ? info.width : t.width, info ? info.height : t.height, t.priv);
        if (info) {
          stream.width = info.width;
          stream.height = info.height;
        }
      } else if (c === 'V_MPEGH/ISO/HEVC' && t.priv) {
        stream.codec = 'hevc';
        stream.extradata = t.priv;
        stream.mp4Entry = hevcEntry(t.width, t.height, t.priv);
      } else if (c === 'V_AV1' && t.priv) {
        stream.codec = 'av1';
        stream.extradata = t.priv;
        stream.mp4Entry = av1Entry(t.width, t.height, t.priv);
      } else if (c === 'V_VP9') stream.codec = 'vp9';
      else if (c === 'V_VP8') stream.codec = 'vp8';
      else return;
      if (t.defaultDuration) stream.frameRate = 1e9 / t.defaultDuration;
      stream.codecPrivate = t.priv;
      stream.codecId = c;
      stream.reorder = stream.codec === 'h264' || stream.codec === 'hevc';
    } else if (t.type === 2) {
      stream = { index: 0, type: 'audio', sampleRate: Math.round(t.rate) || 48000, channels: t.channels || 2, bitsPerSample: t.bits || 0, duration: this.duration, extradata: null };
      if (c === 'A_AAC' || c.startsWith('A_AAC/')) {
        stream.codec = 'aac';
        stream.extradata = t.priv;
      } else if (c === 'A_OPUS') {
        stream.codec = 'opus';
        stream.extradata = t.priv;
        stream.sampleRate = 48000;
        stream.preSkip = t.priv && t.priv.length >= 12 ? t.priv.readUInt16LE(10) : 0;
      } else if (c === 'A_MPEG/L3') stream.codec = 'mp3';
      else if (c === 'A_FLAC' && t.priv && t.priv.length >= 42) {
        stream.codec = 'flac';
        stream.extradata = Buffer.from(t.priv.subarray(8, 42));
      } else if (c === 'A_VORBIS') stream.codec = 'vorbis';
      else if (c === 'A_AC3') stream.codec = 'ac3';
      else return;
      stream.timeScale = stream.sampleRate;
      stream.codecPrivate = t.priv;
      stream.codecId = c;
      if (t.delay) stream.codecDelayNs = t.delay;
    } else return;
    stream.index = this.streams.length;
    this.streams.push(stream);
    this.tracks.set(t.number, { stream, reorder: stream.reorder ? new Reorder(24) : null, lastDelta: 0, lastPts: null });
  }

  toUnits(track, ticks) {
    const ns = ticks * this.scale;
    return Math.round((ns * track.stream.timeScale) / 1e9);
  }

  handleBlock(data, duration, keyFlag) {
    let p = 0;
    const n = readSize(data, 0);
    if (!n) return;
    const number = n.size;
    p = n.len;
    if (p + 3 > data.length) return;
    const rel = data.readInt16BE(p);
    const flags = data[p + 2];
    p += 3;
    const track = this.tracks.get(number);
    if (!track) return;
    const lacing = (flags >> 1) & 3;
    const frames = [];
    if (lacing === 0) frames.push(data.subarray(p));
    else {
      const count = data[p++] + 1;
      const sizes = [];
      if (lacing === 1) {
        for (let i = 0; i < count - 1; i++) {
          let s = 0;
          while (data[p] === 255) {
            s += 255;
            p++;
          }
          s += data[p++];
          sizes.push(s);
        }
      } else if (lacing === 3) {
        const first = readSize(data, p);
        sizes.push(first.size);
        p += first.len;
        for (let i = 1; i < count - 1; i++) {
          const v = readSize(data, p);
          const bias = Math.pow(2, 7 * v.len - 1) - 1;
          sizes.push(sizes[i - 1] + v.size - bias);
          p += v.len;
        }
      } else {
        const each = Math.floor((data.length - p) / count);
        for (let i = 0; i < count - 1; i++) sizes.push(each);
      }
      let used = 0;
      for (const s of sizes) used += s;
      sizes.push(data.length - p - used);
      for (const s of sizes) {
        frames.push(data.subarray(p, p + s));
        p += s;
      }
    }
    const ticks = this.cluster + rel;
    const stream = track.stream;
    const frameDur = duration !== undefined ? this.toUnits(track, duration) : 0;
    frames.forEach((f, i) => {
      let pts = this.toUnits(track, ticks);
      if (frames.length > 1 && stream.type === 'audio' && stream.codec === 'mp3') pts += i * 1152;
      const pkt = { stream: stream.index, pts, dts: pts, duration: frameDur, key: stream.type === 'audio' ? true : keyFlag, data: Buffer.from(f) };
      if (track.reorder) track.reorder.push(pkt);
      else this.finish(track, pkt);
    });
    if (track.reorder) {
      let o;
      while ((o = track.reorder.take())) this.finish(track, o);
    }
  }

  finish(track, pkt) {
    const prev = track.prevPkt;
    if (prev && prev.duration === 0) {
      const delta = pkt.dts - prev.dts;
      if (delta > 0) {
        prev.duration = delta;
        track.lastDelta = delta;
      }
    }
    if (prev && !prev.queued) {
      prev.queued = true;
      this.queue.push(prev);
    }
    track.prevPkt = pkt;
  }

  async fillQueue() {
    const r = this.reader;
    while (!this.queue.length) {
      if (this.pos >= this.segmentEnd || this.ended) {
        this.ended = true;
        for (const t of this.tracks.values()) {
          if (t.reorder) {
            t.reorder.flush();
            let o;
            while ((o = t.reorder.take())) this.finish(t, o);
          }
          if (t.prevPkt && !t.prevPkt.queued) {
            if (t.prevPkt.duration === 0) t.prevPkt.duration = t.lastDelta || 0;
            t.prevPkt.queued = true;
            this.queue.push(t.prevPkt);
          }
        }
        return;
      }
      const h = await this.readHeader(this.pos);
      if (!h) {
        this.pos = this.segmentEnd;
        continue;
      }
      if (h.id !== ids.cluster) {
        this.pos = h.size < 0 ? this.segmentEnd : h.dataStart + h.size;
        continue;
      }
      const end = h.size < 0 ? this.segmentEnd : Math.min(this.segmentEnd, h.dataStart + h.size);
      r.seek(h.dataStart);
      const body = await r.read(end - h.dataStart);
      let consumed = body.length;
      this.cluster = 0;
      let p = 0;
      while (p < body.length) {
        const id = readId(body, p);
        if (!id) break;
        const sz = readSize(body, p + id.len);
        if (!sz) break;
        const ds = p + id.len + sz.len;
        if (h.size < 0 && topLevel.has(id.id)) {
          consumed = p;
          break;
        }
        const de = sz.size < 0 ? body.length : Math.min(body.length, ds + sz.size);
        if (id.id === ids.clusterTimecode) this.cluster = readUint(body.subarray(ds, de));
        else if (id.id === ids.simpleBlock) this.handleBlock(body.subarray(ds, de), undefined, this.simpleKey(body, ds));
        else if (id.id === ids.blockGroup) {
          let blk = null;
          let dur;
          let ref = false;
          parseChildren(body, ds, de, (cid, cs, ce) => {
            if (cid === ids.block) blk = body.subarray(cs, ce);
            else if (cid === ids.blockDuration) dur = readUint(body.subarray(cs, ce));
            else if (cid === ids.referenceBlock) ref = true;
          });
          if (blk) this.handleBlock(blk, dur, !ref);
        }
        p = de;
      }
      this.pos = h.dataStart + consumed;
    }
  }

  simpleKey(body, ds) {
    const n = readSize(body, ds);
    return (body[ds + n.len + 2] & 0x80) !== 0;
  }

  async readPacket() {
    if (!this.queue.length) await this.fillQueue();
    return this.queue.length ? this.queue.shift() : null;
  }

  async close() {
    await this.reader.close();
  }
}

export { MatroskaDemuxer, ids as matroskaIds };
