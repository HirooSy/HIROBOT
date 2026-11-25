import { badData, noSupport } from '../errors.js';
import { Vec, readU64BE } from '../util.js';
import { parseMp4Ilst } from '../tags.js';
import { buildOpusHead } from '../codec/opus.js';


function readBox(buf, off, end) {
  if (off + 8 > end) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString('latin1', off + 4, off + 8);
  let header = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = readU64BE(buf, off + 8);
    header = 16;
  } else if (size === 0) size = end - off;
  if (size < header || off + size > end) return null;
  return { type, start: off + header, end: off + size, size, header };
}

function children(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const b = readBox(buf, p, end);
    if (!b) break;
    out.push(b);
    p = b.end;
  }
  return out;
}

function find(list, type) {
  for (const b of list) if (b.type === type) return b;
  return null;
}

function readDescrLen(buf, pos) {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[pos.v++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return len;
}

function parseEsds(buf, start, end) {
  const pos = { v: start + 4 };
  const out = { oti: 0, dsi: null, avgBitrate: 0, maxBitrate: 0 };
  if (buf[pos.v++] !== 0x03) return out;
  readDescrLen(buf, pos);
  pos.v += 2;
  const flags = buf[pos.v++];
  if (flags & 0x80) pos.v += 2;
  if (flags & 0x40) pos.v += 1 + buf[pos.v];
  if (flags & 0x20) pos.v += 2;
  if (buf[pos.v++] !== 0x04) return out;
  readDescrLen(buf, pos);
  out.oti = buf[pos.v++];
  pos.v += 1;
  pos.v += 3;
  out.maxBitrate = buf.readUInt32BE(pos.v);
  out.avgBitrate = buf.readUInt32BE(pos.v + 4);
  pos.v += 8;
  if (pos.v < end && buf[pos.v] === 0x05) {
    pos.v++;
    const len = readDescrLen(buf, pos);
    out.dsi = Buffer.from(buf.subarray(pos.v, Math.min(pos.v + len, end)));
  }
  return out;
}

function audioCodecFromOti(oti) {
  if (oti === 0x40 || (oti >= 0x66 && oti <= 0x68)) return 'aac';
  if (oti === 0x69 || oti === 0x6b) return 'mp3';
  if (oti === 0xdd) return 'vorbis';
  return 'mp4a_0x' + oti.toString(16);
}


function parseSampleEntry(buf, kind) {
  const raw = Buffer.from(buf);
  const fourcc = raw.toString('latin1', 4, 8);
  const out = { raw, fourcc };
  let childStart;
  if (kind === 'soun') {
    const version = raw.readUInt16BE(16);
    out.channels = raw.readUInt16BE(24);
    out.bits = raw.readUInt16BE(26);
    out.sampleRate = raw.readUInt32BE(32) / 65536;
    childStart = 36;
    if (version === 1) childStart = 52;
    else if (version === 2) {
      out.sampleRate = raw.readDoubleBE(40);
      out.channels = raw.readUInt32BE(48);
      childStart = 72;
    }
  } else if (kind === 'vide') {
    out.width = raw.readUInt16BE(32);
    out.height = raw.readUInt16BE(34);
    childStart = 86;
  } else return out;
  const walk = (start, end) => {
    for (const b of children(raw, start, end)) {
      if (b.type === 'wave') walk(b.start, b.end);
      else if (b.type === 'esds') out.esds = parseEsds(raw, b.start, b.end);
      else if (b.type === 'dOps') out.dops = raw.subarray(b.start, b.end);
      else if (b.type === 'dfLa') out.dfla = raw.subarray(b.start, b.end);
      else if (b.type === 'avcC' || b.type === 'hvcC' || b.type === 'av1C' || b.type === 'vpcC') out.config = Buffer.from(raw.subarray(b.start, b.end));
      else if (b.type === 'alac') out.alac = Buffer.from(raw.subarray(b.start, b.end));
    }
  };
  if (childStart < raw.length) walk(childStart, raw.length);
  return out;
}

function opusHeadFromDops(dops) {
  const channels = dops[1];
  const info = {
    channels,
    preSkip: dops.readUInt16BE(2),
    inputRate: dops.readUInt32BE(4),
    gain: dops.readInt16BE(8),
    family: dops[10],
  };
  return buildOpusHead(info, info.family ? dops.subarray(11) : null);
}

class Track {
  constructor() {
    this.sizes = new Vec(Uint32Array, 1024);
    this.offsets = new Vec(Float64Array, 1024);
    this.dts = new Vec(Float64Array, 1024);
    this.cto = new Vec(Int32Array, 1024);
    this.sync = new Vec(Uint8Array, 1024);
    this.hasCto = false;
    this.allSync = true;
    this.cursor = 0;
    this.shift = 0;
    this.lastDelta = 0;
    this.nextDts = 0;
  }

  add(size, offset, dts, cto, key) {
    this.sizes.push(size);
    this.offsets.push(offset);
    this.dts.push(dts);
    this.cto.push(cto);
    this.sync.push(key ? 1 : 0);
    if (cto !== 0) this.hasCto = true;
    if (!key) this.allSync = false;
  }

  get count() {
    return this.sizes.length;
  }
}

class Mp4Demuxer {
  static probe(head) {
    if (head.length < 12) return false;
    const t = head.toString('latin1', 4, 8);
    return t === 'ftyp' || t === 'moov' || t === 'mdat' || t === 'free' || t === 'wide' || t === 'skip' || t === 'styp';
  }

  static async open(reader) {
    const demuxer = new Mp4Demuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'mp4';
    this.tags = {};
    this.streams = [];
    this.tracks = [];
    this.brand = '';
  }

  async init() {
    const r = this.reader;
    let pos = 0;
    let moov = null;
    const moofs = [];
    while (pos + 8 <= r.size) {
      r.seek(pos);
      const head = await r.read(16);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1 && head.length >= 16) size = readU64BE(head, 8);
      else if (size === 0) size = r.size - pos;
      if (size < 8) break;
      if (type === 'ftyp') {
        r.seek(pos + 8);
        this.brand = (await r.read(4)).toString('latin1');
      } else if (type === 'moov' && !moov) {
        r.seek(pos);
        moov = await r.read(Math.min(size, r.size - pos));
      } else if (type === 'moof') moofs.push({ pos, size: Math.min(size, r.size - pos) });
      pos += size;
    }
    if (!moov) throw badData('mp4: missing moov box');
    const top = readBox(moov, 0, moov.length);
    if (!top) throw badData('mp4: truncated moov box');
    this.parseMoov(moov, top);
    if (moofs.length) await this.parseFragments(moofs);
    this.finalize();
  }

  parseMoov(buf, moov) {
    const kids = children(buf, moov.start, moov.end);
    const mvhd = find(kids, 'mvhd');
    if (mvhd) {
      const v = buf[mvhd.start];
      this.movieTimescale = buf.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
      this.movieDuration = v === 1 ? readU64BE(buf, mvhd.start + 24) : buf.readUInt32BE(mvhd.start + 16);
    } else this.movieTimescale = 1000;
    const mvex = find(kids, 'mvex');
    this.trex = new Map();
    if (mvex) {
      for (const t of children(buf, mvex.start, mvex.end)) {
        if (t.type !== 'trex') continue;
        this.trex.set(buf.readUInt32BE(t.start + 4), {
          duration: buf.readUInt32BE(t.start + 12),
          size: buf.readUInt32BE(t.start + 16),
          flags: buf.readUInt32BE(t.start + 20),
        });
      }
    }
    this.fragmented = Boolean(mvex);
    for (const k of kids) {
      if (k.type === 'trak') this.parseTrak(buf, k);
      else if (k.type === 'udta') this.parseUdta(buf, k);
      else if (k.type === 'meta') this.parseMeta(buf, k);
    }
  }

  parseUdta(buf, udta) {
    for (const m of children(buf, udta.start, udta.end)) if (m.type === 'meta') this.parseMeta(buf, m);
  }

  parseMeta(buf, meta) {
    const start = buf.readUInt32BE(meta.start) === 0 ? meta.start + 4 : meta.start;
    const ilst = find(children(buf, start, meta.end), 'ilst');
    if (ilst) Object.assign(this.tags, parseMp4Ilst(buf.subarray(ilst.start, ilst.end)));
  }

  parseTrak(buf, trak) {
    const kids = children(buf, trak.start, trak.end);
    const tkhd = find(kids, 'tkhd');
    const mdia = find(kids, 'mdia');
    if (!tkhd || !mdia) return;
    const tv = buf[tkhd.start];
    const id = buf.readUInt32BE(tkhd.start + (tv === 1 ? 20 : 12));
    const mk = children(buf, mdia.start, mdia.end);
    const mdhd = find(mk, 'mdhd');
    const hdlr = find(mk, 'hdlr');
    const minf = find(mk, 'minf');
    if (!mdhd || !hdlr || !minf) return;
    const mv = buf[mdhd.start];
    const timescale = buf.readUInt32BE(mdhd.start + (mv === 1 ? 20 : 12));
    const duration = mv === 1 ? readU64BE(buf, mdhd.start + 24) : buf.readUInt32BE(mdhd.start + 16);
    const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    if (handler !== 'soun' && handler !== 'vide') return;
    const stbl = find(children(buf, minf.start, minf.end), 'stbl');
    if (!stbl) return;
    const sk = children(buf, stbl.start, stbl.end);
    const stsd = find(sk, 'stsd');
    if (!stsd) return;
    const entrySize = buf.readUInt32BE(stsd.start + 8);
    const entry = parseSampleEntry(buf.subarray(stsd.start + 8, stsd.start + 8 + entrySize), handler);
    const track = new Track();
    track.id = id;
    track.handler = handler;
    track.timescale = timescale;
    track.mediaDuration = duration;
    track.entry = entry;
    if (tkhd.end - tkhd.start >= 8) track.tkWidth = buf.readUInt32BE(tkhd.end - 8) / 65536;
    if (tkhd.end - tkhd.start >= 8) track.tkHeight = buf.readUInt32BE(tkhd.end - 4) / 65536;
    const edts = find(kids, 'edts');
    if (edts) {
      const elst = find(children(buf, edts.start, edts.end), 'elst');
      if (elst) this.parseElst(buf, elst, track);
    }
    this.buildTable(buf, sk, track);
    this.tracks.push(track);
  }

  parseElst(buf, elst, track) {
    const v = buf[elst.start];
    const n = buf.readUInt32BE(elst.start + 4);
    let p = elst.start + 8;
    let empty = 0;
    let shift = 0;
    for (let i = 0; i < n; i++) {
      let segDur;
      let mediaTime;
      if (v === 1) {
        segDur = readU64BE(buf, p);
        mediaTime = Number(buf.readBigInt64BE(p + 8));
        p += 20;
      } else {
        segDur = buf.readUInt32BE(p);
        mediaTime = buf.readInt32BE(p + 4);
        p += 12;
      }
      if (mediaTime === -1) {
        empty += Math.round((segDur * track.timescale) / this.movieTimescale);
      } else {
        shift = empty - mediaTime;
        track.hasEdit = true;
        break;
      }
    }
    if (!track.hasEdit) shift = empty;
    track.shift = shift;
  }

  buildTable(buf, sk, track) {
    const stsz = find(sk, 'stsz');
    const stts = find(sk, 'stts');
    const stsc = find(sk, 'stsc');
    const stco = find(sk, 'stco') || find(sk, 'co64');
    if (!stsz || !stts || !stsc || !stco) {
      if (this.fragmented) return;
      throw badData('mp4: incomplete sample table');
    }
    const uniform = buf.readUInt32BE(stsz.start + 4);
    const count = buf.readUInt32BE(stsz.start + 8);
    if (count > 40000000) throw noSupport('mp4: too many samples');
    const sizes = new Uint32Array(count);
    if (uniform) sizes.fill(uniform);
    else for (let i = 0; i < count; i++) sizes[i] = buf.readUInt32BE(stsz.start + 12 + i * 4);
    const dts = new Float64Array(count);
    {
      const entries = buf.readUInt32BE(stts.start + 4);
      let p = stts.start + 8;
      let i = 0;
      let t = 0;
      let last = 0;
      for (let e = 0; e < entries && i < count; e++, p += 8) {
        const c = buf.readUInt32BE(p);
        const d = buf.readUInt32BE(p + 4);
        last = d;
        for (let k = 0; k < c && i < count; k++) {
          dts[i++] = t;
          t += d;
        }
      }
      track.lastDelta = last;
    }
    let cto = null;
    const ctts = find(sk, 'ctts');
    if (ctts) {
      cto = new Int32Array(count);
      const signed = buf[ctts.start] === 1;
      const entries = buf.readUInt32BE(ctts.start + 4);
      let p = ctts.start + 8;
      let i = 0;
      for (let e = 0; e < entries && i < count; e++, p += 8) {
        const c = buf.readUInt32BE(p);
        const v = signed ? buf.readInt32BE(p + 4) : buf.readUInt32BE(p + 4) | 0;
        for (let k = 0; k < c && i < count; k++) cto[i++] = v;
      }
    }
    let sync = null;
    const stss = find(sk, 'stss');
    if (stss) {
      sync = new Uint8Array(count);
      const n = buf.readUInt32BE(stss.start + 4);
      for (let i = 0; i < n; i++) {
        const idx = buf.readUInt32BE(stss.start + 8 + i * 4) - 1;
        if (idx >= 0 && idx < count) sync[idx] = 1;
      }
    }
    const co64 = stco.type === 'co64';
    const chunks = buf.readUInt32BE(stco.start + 4);
    const stscEntries = buf.readUInt32BE(stsc.start + 4);
    let sp = stsc.start + 8;
    let sample = 0;
    let runIdx = 0;
    let perChunk = buf.readUInt32BE(sp + 4);
    let nextFirst = stscEntries > 1 ? buf.readUInt32BE(sp + 12) : Infinity;
    for (let c = 1; c <= chunks && sample < count; c++) {
      while (c >= nextFirst) {
        runIdx++;
        sp += 12;
        perChunk = buf.readUInt32BE(sp + 4);
        nextFirst = runIdx + 1 < stscEntries ? buf.readUInt32BE(sp + 12) : Infinity;
      }
      let offset = co64 ? readU64BE(buf, stco.start + 8 + (c - 1) * 8) : buf.readUInt32BE(stco.start + 8 + (c - 1) * 4);
      for (let k = 0; k < perChunk && sample < count; k++) {
        const size = sizes[sample];
        track.add(size, offset, dts[sample], cto ? cto[sample] : 0, sync ? sync[sample] === 1 : true);
        offset += size;
        sample++;
      }
    }
    if (count > 1) track.lastDelta = track.lastDelta || dts[count - 1] - dts[count - 2];
  }

  async parseFragments(moofs) {
    const r = this.reader;
    const byId = new Map();
    for (const t of this.tracks) byId.set(t.id, t);
    for (const m of moofs) {
      r.seek(m.pos);
      const buf = await r.read(m.size);
      const moof = readBox(buf, 0, buf.length);
      if (!moof) continue;
      for (const traf of children(buf, moof.start, moof.end)) {
        if (traf.type !== 'traf') continue;
        const kids = children(buf, traf.start, traf.end);
        const tfhd = find(kids, 'tfhd');
        if (!tfhd) continue;
        const flags = buf.readUIntBE(tfhd.start + 1, 3);
        const id = buf.readUInt32BE(tfhd.start + 4);
        const track = byId.get(id);
        if (!track) continue;
        const trex = this.trex.get(id) || { duration: 0, size: 0, flags: 0 };
        let p = tfhd.start + 8;
        let base = m.pos;
        if (flags & 1) {
          base = readU64BE(buf, p);
          p += 8;
        }
        if (flags & 2) p += 4;
        let defDur = trex.duration;
        let defSize = trex.size;
        let defFlags = trex.flags;
        if (flags & 8) {
          defDur = buf.readUInt32BE(p);
          p += 4;
        }
        if (flags & 0x10) {
          defSize = buf.readUInt32BE(p);
          p += 4;
        }
        if (flags & 0x20) {
          defFlags = buf.readUInt32BE(p);
          p += 4;
        }
        const tfdt = find(kids, 'tfdt');
        if (tfdt) track.nextDts = buf[tfdt.start] === 1 ? readU64BE(buf, tfdt.start + 4) : buf.readUInt32BE(tfdt.start + 4);
        let cursor = base;
        for (const trun of kids) {
          if (trun.type !== 'trun') continue;
          const tf = buf.readUIntBE(trun.start + 1, 3);
          const n = buf.readUInt32BE(trun.start + 4);
          let q = trun.start + 8;
          if (tf & 1) {
            cursor = base + buf.readInt32BE(q);
            q += 4;
          }
          let firstFlags = null;
          if (tf & 4) {
            firstFlags = buf.readUInt32BE(q);
            q += 4;
          }
          for (let i = 0; i < n; i++) {
            let dur = defDur;
            let size = defSize;
            let sflags = defFlags;
            let off = 0;
            if (tf & 0x100) {
              dur = buf.readUInt32BE(q);
              q += 4;
            }
            if (tf & 0x200) {
              size = buf.readUInt32BE(q);
              q += 4;
            }
            if (tf & 0x400) {
              sflags = buf.readUInt32BE(q);
              q += 4;
            } else if (i === 0 && firstFlags !== null) sflags = firstFlags;
            if (tf & 0x800) {
              off = buf[trun.start] === 1 ? buf.readInt32BE(q) : buf.readUInt32BE(q) | 0;
              q += 4;
            }
            track.add(size, cursor, track.nextDts, off, ((sflags >> 16) & 1) === 0);
            track.nextDts += dur;
            track.lastDelta = dur;
            cursor += size;
          }
        }
      }
    }
  }

  finalize() {
    let index = 0;
    let longest = 0;
    for (const t of this.tracks) {
      const e = t.entry;
      const n = t.count;
      const view = {
        sizes: t.sizes.view(),
        offsets: t.offsets.view(),
        dts: t.dts.view(),
        cto: t.cto.view(),
        sync: t.sync.view(),
      };
      t.v = view;
      let duration;
      if (n > 0) duration = (view.dts[n - 1] + t.lastDelta) / t.timescale;
      else duration = t.mediaDuration / t.timescale;
      if (!(duration > 0) && t.mediaDuration) duration = t.mediaDuration / t.timescale;
      let bytes = 0;
      for (let i = 0; i < n; i++) bytes += view.sizes[i];
      const stream = { index: index++, type: t.handler === 'soun' ? 'audio' : 'video', timeScale: t.timescale, duration, mp4Entry: e.raw, trackId: t.id };
      if (t.handler === 'soun') {
        stream.channels = e.channels;
        stream.sampleRate = Math.round(e.sampleRate) || t.timescale;
        let codec = { 'ac-3': 'ac3', 'ec-3': 'eac3', alac: 'alac', fLaC: 'flac', Opus: 'opus', '.mp3': 'mp3', samr: 'amr_nb', sawb: 'amr_wb' }[e.fourcc];
        stream.extradata = null;
        if (e.fourcc === 'mp4a') {
          const oti = e.esds ? e.esds.oti : 0x40;
          codec = audioCodecFromOti(oti);
          if (e.esds && e.esds.dsi) stream.extradata = e.esds.dsi;
          if (e.esds && e.esds.avgBitrate) stream.bitRate = e.esds.avgBitrate;
        } else if (e.fourcc === 'Opus' && e.dops) {
          stream.extradata = opusHeadFromDops(e.dops);
          stream.preSkip = e.dops.readUInt16BE(2);
          stream.sampleRate = 48000;
        } else if (e.fourcc === 'fLaC' && e.dfla) {
          stream.extradata = Buffer.from(e.dfla.subarray(8, 42));
        } else if (e.fourcc === 'alac' && e.alac) stream.extradata = e.alac;
        if (!codec) codec = e.fourcc.trim().toLowerCase();
        stream.codec = codec;
        stream.bitsPerSample = e.bits;
        if (codec === 'aac' && stream.extradata && stream.extradata.length >= 2) {
          const asc = stream.extradata;
          const sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
          const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
          const chan = (asc[1] >> 3) & 15;
          if (sfi < 13 && stream.sampleRate !== rates[sfi] && (asc[0] >> 3) < 5) stream.sampleRate = rates[sfi];
          if (chan > 0 && chan < 7 && !stream.channels) stream.channels = chan;
        }
      } else {
        stream.codec = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', mp4v: 'mpeg4', jpeg: 'mjpeg', apch: 'prores', apcn: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores' }[e.fourcc] || e.fourcc.trim().toLowerCase();
        stream.width = e.width || Math.round(t.tkWidth || 0);
        stream.height = e.height || Math.round(t.tkHeight || 0);
        stream.extradata = e.config || null;
        if (n > 1 && duration > 0) stream.frameRate = n / duration;
      }
      if (!stream.bitRate && duration > 0 && bytes > 0) stream.bitRate = Math.round((bytes * 8) / duration);
      this.streams.push(stream);
      t.stream = stream;
      if (duration > longest) longest = duration;
    }
    if (!this.streams.length) throw badData('mp4: no audio or video tracks');
    this.duration = longest;
  }

  binarySearch(t, target) {
    const dts = t.v.dts;
    let lo = 0;
    let hi = dts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dts[mid] + t.v.cto[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  async seek(seconds) {
    const video = this.tracks.find((t) => t.handler === 'vide' && t.count > 0);
    let target = seconds;
    if (video) {
      const goal = seconds * video.timescale - video.shift;
      let idx = 0;
      const v = video.v;
      for (let i = 0; i < video.count; i++) {
        if (v.sync[i] !== 1) continue;
        if (v.dts[i] + v.cto[i] <= goal + 1e-6) idx = i;
        else if (v.dts[i] > goal) break;
      }
      if (!video.v.sync[idx]) for (let i = 0; i < video.count; i++) if (v.sync[i] === 1) { idx = i; break; }
      target = (v.dts[idx] + v.cto[idx] + video.shift) / video.timescale;
      video.cursor = idx;
    }
    for (const t of this.tracks) {
      if (t === video) continue;
      const goal = target * t.timescale - t.shift;
      t.cursor = this.binarySearch(t, goal - 0.5);
      while (t.cursor < t.count && t.v.dts[t.cursor] + t.v.cto[t.cursor] < goal - 0.5) t.cursor++;
    }
    return target;
  }

  async readPacket() {
    let best = null;
    for (const t of this.tracks) {
      if (t.cursor >= t.count) continue;
      if (!best || t.v.offsets[t.cursor] < best.v.offsets[best.cursor]) best = t;
    }
    if (!best) return null;
    const i = best.cursor++;
    const v = best.v;
    this.reader.seek(v.offsets[i]);
    const data = await this.reader.read(v.sizes[i]);
    if (data.length < v.sizes[i]) {
      best.cursor = best.count;
      return this.readPacket();
    }
    const dts = v.dts[i] + best.shift;
    const duration = i + 1 < best.count ? v.dts[i + 1] - v.dts[i] : best.lastDelta;
    return { stream: best.stream.index, pts: dts + v.cto[i], dts, duration, key: v.sync[i] === 1, data };
  }

  async close() {
    await this.reader.close();
  }
}

export {
  Mp4Demuxer,
};
