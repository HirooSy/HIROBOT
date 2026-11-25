import { noSupport, badArg } from '../errors.js';
import { Vec } from '../util.js';
import { buildMp4Meta } from '../tags.js';
import { parseOpusHead } from '../codec/opus.js';

const macEpoch = 2082844800;
const chunkBytes = 1 << 20;

function box(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.length;
  const out = Buffer.allocUnsafe(len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 'latin1');
  let o = 8;
  for (const p of parts) {
    p.copy(out, o);
    o += p.length;
  }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  return box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function descr(tag, payload) {
  const len = payload.length;
  const head = len < 128 ? Buffer.from([tag, len]) : Buffer.from([tag, 0x80 | (len >> 7), len & 0x7f]);
  return Buffer.concat([head, payload]);
}

function esds(oti, dsi, maxRate, avgRate) {
  const dsiDescr = dsi && dsi.length ? descr(0x05, dsi) : Buffer.alloc(0);
  const config = descr(0x04, Buffer.concat([Buffer.from([oti, 0x15, 0, 0, 0]), u32(maxRate), u32(avgRate), dsiDescr]));
  const sl = descr(0x06, Buffer.from([2]));
  return fullBox('esds', 0, 0, descr(0x03, Buffer.concat([u16(0), Buffer.from([0]), config, sl])));
}

function audioHeader(channels, bits, rate) {
  const b = Buffer.alloc(28);
  b.writeUInt16BE(1, 6);
  b.writeUInt16BE(channels, 16);
  b.writeUInt16BE(bits, 18);
  b.writeUInt32BE(rate <= 65535 ? rate * 65536 : 0, 24);
  return b;
}

function sampleEntry(stream) {
  if (stream.mp4Entry) return stream.mp4Entry;
  const rate = stream.sampleRate;
  const bitRate = stream.bitRate || 0;
  if (stream.codec === 'aac') return box('mp4a', audioHeader(stream.channels, 16, rate), esds(0x40, stream.extradata, bitRate, bitRate));
  if (stream.codec === 'mp3') return box('mp4a', audioHeader(stream.channels, 16, rate), esds(0x6b, null, bitRate, bitRate));
  if (stream.codec === 'opus') {
    const head = parseOpusHead(stream.extradata);
    const dops = Buffer.alloc(11);
    dops[1] = head.channels;
    dops.writeUInt16BE(head.preSkip, 2);
    dops.writeUInt32BE(head.inputRate, 4);
    dops.writeInt16BE(head.gain, 8);
    dops[10] = head.family;
    const extra = head.family ? stream.extradata.subarray(19) : Buffer.alloc(0);
    return box('Opus', audioHeader(head.channels, 16, 48000), box('dOps', dops, extra));
  }
  if (stream.codec === 'flac') {
    return box('fLaC', audioHeader(stream.channels, stream.bitsPerSample || 16, rate), fullBox('dfLa', 0, 0, Buffer.from([0x80, 0, 0, 34]), stream.extradata));
  }
  throw noSupport('mp4: cannot write codec ' + stream.codec);
}

class MuxTrack {
  constructor(stream, id) {
    this.stream = stream;
    this.id = id;
    this.timescale = stream.timeScale;
    this.video = stream.type === 'video';
    this.sizes = new Vec(Uint32Array, 1024);
    this.dts = new Vec(Float64Array, 1024);
    this.cto = new Vec(Int32Array, 1024);
    this.sync = new Vec(Uint8Array, 1024);
    this.chunkOffsets = new Vec(Float64Array, 256);
    this.chunkCounts = new Vec(Uint32Array, 256);
    this.hasCto = false;
    this.negCto = false;
    this.allSync = true;
    this.count = 0;
    this.firstDts = 0;
    this.lastDur = 0;
    this.minPts = Infinity;
    this.maxPtsEnd = -Infinity;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingDur = 0;
  }
}

class Mp4Muxer {
  constructor(sink, options) {
    this.sink = sink;
    this.tags = options.tags || {};
    this.faststart = Boolean(options.faststart);
    this.brand = options.brand || 'mp4';
    this.tracks = [];
    this.mdatStart = 0;
  }

  static accepts(stream) {
    if (stream.type !== 'audio' && stream.type !== 'video') return false;
    if (stream.mp4Entry) return true;
    return stream.type === 'audio' && ['aac', 'mp3', 'opus', 'flac'].includes(stream.codec);
  }

  async open(streams) {
    if (!streams.length) throw badArg('mp4: no streams to write');
    for (const s of streams) if (!Mp4Muxer.accepts(s)) throw noSupport('mp4: unsupported stream codec ' + s.codec);
    this.tracks = streams.map((s, i) => new MuxTrack(s, i + 1));
    let major = 'isom';
    let minor = 512;
    let compat = ['isom', 'iso2', 'mp41'];
    if (streams.some((s) => s.codec === 'h264')) compat.splice(2, 0, 'avc1');
    if (this.brand === 'm4a') {
      major = 'M4A ';
      minor = 0;
      compat = ['M4A ', 'mp42', 'isom', '\0\0\0\0'];
    } else if (this.brand === 'mov') {
      major = 'qt  ';
      minor = 0;
      compat = ['qt  '];
    }
    const ftyp = box('ftyp', Buffer.from(major, 'latin1'), u32(minor), ...compat.map((c) => Buffer.from(c, 'latin1')));
    this.mdatStart = ftyp.length;
    const free = Buffer.alloc(16);
    free.writeUInt32BE(8, 0);
    free.write('free', 4, 'latin1');
    free.writeUInt32BE(8, 8);
    free.write('mdat', 12, 'latin1');
    await this.sink.write(ftyp);
    await this.sink.write(free);
  }

  async flushChunk(t) {
    if (!t.pending.length) return;
    t.chunkOffsets.push(this.sink.pos);
    t.chunkCounts.push(t.pending.length);
    for (const b of t.pending) await this.sink.write(b);
    t.pending = [];
    t.pendingBytes = 0;
    t.pendingDur = 0;
  }

  async writePacket(index, packet) {
    const t = this.tracks[index];
    if (!t) throw badArg('mp4: invalid stream index');
    const dts = packet.dts === undefined ? packet.pts : packet.dts;
    const pts = packet.pts === undefined ? dts : packet.pts;
    if (t.count === 0) t.firstDts = dts;
    if (pts < t.minPts) t.minPts = pts;
    if (pts + (packet.duration || 0) > t.maxPtsEnd) t.maxPtsEnd = pts + (packet.duration || 0);
    t.dts.push(dts - t.firstDts);
    const cto = pts - dts;
    t.cto.push(cto);
    if (cto !== 0) t.hasCto = true;
    if (cto < 0) t.negCto = true;
    t.sync.push(packet.key ? 1 : 0);
    if (!packet.key) t.allSync = false;
    t.sizes.push(packet.data.length);
    t.count++;
    t.lastDur = packet.duration || 0;
    t.pending.push(packet.data);
    t.pendingBytes += packet.data.length;
    t.pendingDur += packet.duration || 0;
    if (t.pendingDur >= t.timescale || t.pendingBytes >= chunkBytes) await this.flushChunk(t);
  }

  trackDuration(t) {
    if (t.count === 0) return 0;
    return t.dts.get(t.count - 1) + t.lastDur;
  }

  buildTrak(t, delta, use64) {
    const toMovie = (ticks) => Math.round((ticks * 1000) / t.timescale);
    const media = this.trackDuration(t);
    const d0 = t.firstDts;
    const p0 = t.count ? t.minPts : 0;
    const end = t.count ? t.maxPtsEnd : 0;
    let edit = null;
    if (p0 > 0) edit = [[toMovie(p0), -1], [toMovie(end - p0), p0 - d0]];
    else if (d0 !== 0) edit = [[toMovie(end), -d0]];
    const duration = toMovie(Math.max(end, 0));
    const now = Math.floor(Date.now() / 1000) + macEpoch;
    const matrix = Buffer.alloc(36);
    matrix.writeUInt32BE(0x00010000, 0);
    matrix.writeUInt32BE(0x00010000, 16);
    matrix.writeUInt32BE(0x40000000, 32);
    const tkhd = Buffer.alloc(84);
    tkhd[3] = 3;
    tkhd.writeUInt32BE(now, 4);
    tkhd.writeUInt32BE(now, 8);
    tkhd.writeUInt32BE(t.id, 12);
    tkhd.writeUInt32BE(Math.min(duration, 0xffffffff), 20);
    if (!t.video) tkhd.writeUInt16BE(0x0100, 36);
    matrix.copy(tkhd, 40);
    if (t.video) {
      tkhd.writeUInt32BE((t.stream.width || 0) * 65536, 76);
      tkhd.writeUInt32BE((t.stream.height || 0) * 65536, 80);
    }
    const parts = [box('tkhd', tkhd)];
    if (edit) {
      const wide = edit.some((e) => e[0] > 0x7fffffff || e[1] > 0x7fffffff);
      const body = Buffer.alloc(4 + edit.length * (wide ? 20 : 12));
      body.writeUInt32BE(edit.length, 0);
      let p = 4;
      for (const [seg, mt] of edit) {
        if (wide) {
          body.writeUInt32BE(Math.floor(seg / 4294967296), p);
          body.writeUInt32BE(seg >>> 0, p + 4);
          body.writeBigInt64BE(BigInt(mt), p + 8);
          body.writeInt16BE(1, p + 16);
          p += 20;
        } else {
          body.writeUInt32BE(seg, p);
          body.writeInt32BE(mt, p + 4);
          body.writeInt16BE(1, p + 8);
          p += 12;
        }
      }
      parts.push(box('edts', fullBox('elst', wide ? 1 : 0, 0, body)));
    }
    const mdhdWide = media > 0xffffffff;
    const mdhdBody = Buffer.alloc(mdhdWide ? 36 : 20);
    if (mdhdWide) {
      mdhdBody.writeUInt32BE(now, 4);
      mdhdBody.writeUInt32BE(now, 12);
      mdhdBody.writeUInt32BE(t.timescale, 16);
      mdhdBody.writeUInt32BE(Math.floor(media / 4294967296), 20);
      mdhdBody.writeUInt32BE(media >>> 0, 24);
      mdhdBody.writeUInt16BE(0x55c4, 28);
    } else {
      mdhdBody.writeUInt32BE(now, 0);
      mdhdBody.writeUInt32BE(now, 4);
      mdhdBody.writeUInt32BE(t.timescale, 8);
      mdhdBody.writeUInt32BE(media, 12);
      mdhdBody.writeUInt16BE(0x55c4, 16);
    }
    const name = Buffer.from(t.video ? 'VideoHandler\0' : 'SoundHandler\0', 'latin1');
    const hdlr = fullBox('hdlr', 0, 0, Buffer.alloc(4), Buffer.from(t.video ? 'vide' : 'soun', 'latin1'), Buffer.alloc(12), name);
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const mediaHeader = t.video ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : fullBox('smhd', 0, 0, Buffer.alloc(4));
    const n = t.count;
    const dts = t.dts.view();
    const stts = [];
    for (let i = 0; i < n; i++) {
      const d = i + 1 < n ? dts[i + 1] - dts[i] : t.lastDur;
      const last = stts[stts.length - 1];
      if (last && last[1] === d) last[0]++;
      else stts.push([1, d]);
    }
    const sttsBuf = Buffer.alloc(4 + stts.length * 8);
    sttsBuf.writeUInt32BE(stts.length, 0);
    stts.forEach((e, i) => {
      sttsBuf.writeUInt32BE(e[0], 4 + i * 8);
      sttsBuf.writeUInt32BE(e[1] >>> 0, 8 + i * 8);
    });
    const stblParts = [fullBox('stsd', 0, 0, u32(1), sampleEntry(t.stream)), fullBox('stts', 0, 0, sttsBuf)];
    if (t.hasCto) {
      const cto = t.cto.view();
      const runs = [];
      for (let i = 0; i < n; i++) {
        const last = runs[runs.length - 1];
        if (last && last[1] === cto[i]) last[0]++;
        else runs.push([1, cto[i]]);
      }
      const buf = Buffer.alloc(4 + runs.length * 8);
      buf.writeUInt32BE(runs.length, 0);
      runs.forEach((e, i) => {
        buf.writeUInt32BE(e[0], 4 + i * 8);
        buf.writeInt32BE(e[1], 8 + i * 8);
      });
      stblParts.push(fullBox('ctts', t.negCto ? 1 : 0, 0, buf));
    }
    if (!t.allSync) {
      const sync = t.sync.view();
      let c = 0;
      for (let i = 0; i < n; i++) if (sync[i]) c++;
      const buf = Buffer.alloc(4 + c * 4);
      buf.writeUInt32BE(c, 0);
      let p = 4;
      for (let i = 0; i < n; i++) if (sync[i]) {
        buf.writeUInt32BE(i + 1, p);
        p += 4;
      }
      stblParts.push(fullBox('stss', 0, 0, buf));
    }
    const counts = t.chunkCounts.view();
    const stsc = [];
    for (let i = 0; i < counts.length; i++) {
      const last = stsc[stsc.length - 1];
      if (!last || last[1] !== counts[i]) stsc.push([i + 1, counts[i]]);
    }
    const stscBuf = Buffer.alloc(4 + stsc.length * 12);
    stscBuf.writeUInt32BE(stsc.length, 0);
    stsc.forEach((e, i) => {
      stscBuf.writeUInt32BE(e[0], 4 + i * 12);
      stscBuf.writeUInt32BE(e[1], 8 + i * 12);
      stscBuf.writeUInt32BE(1, 12 + i * 12);
    });
    stblParts.push(fullBox('stsc', 0, 0, stscBuf));
    const sizes = t.sizes.view();
    let uniform = n > 0;
    for (let i = 1; i < n && uniform; i++) if (sizes[i] !== sizes[0]) uniform = false;
    let stszBuf;
    if (uniform) {
      stszBuf = Buffer.alloc(8);
      stszBuf.writeUInt32BE(sizes[0], 0);
      stszBuf.writeUInt32BE(n, 4);
    } else {
      stszBuf = Buffer.alloc(8 + n * 4);
      stszBuf.writeUInt32BE(n, 4);
      for (let i = 0; i < n; i++) stszBuf.writeUInt32BE(sizes[i], 8 + i * 4);
    }
    stblParts.push(fullBox('stsz', 0, 0, stszBuf));
    const offs = t.chunkOffsets.view();
    if (use64) {
      const buf = Buffer.alloc(4 + offs.length * 8);
      buf.writeUInt32BE(offs.length, 0);
      for (let i = 0; i < offs.length; i++) {
        const v = offs[i] + delta;
        buf.writeUInt32BE(Math.floor(v / 4294967296), 4 + i * 8);
        buf.writeUInt32BE(v >>> 0, 8 + i * 8);
      }
      stblParts.push(fullBox('co64', 0, 0, buf));
    } else {
      const buf = Buffer.alloc(4 + offs.length * 4);
      buf.writeUInt32BE(offs.length, 0);
      for (let i = 0; i < offs.length; i++) buf.writeUInt32BE(offs[i] + delta, 4 + i * 4);
      stblParts.push(fullBox('stco', 0, 0, buf));
    }
    const minf = box('minf', mediaHeader, dinf, box('stbl', ...stblParts));
    parts.push(box('mdia', fullBox('mdhd', mdhdWide ? 1 : 0, 0, mdhdBody), hdlr, minf));
    return { trak: box('trak', ...parts), duration };
  }

  buildMoov(delta, use64) {
    const traks = [];
    let movieDuration = 0;
    for (const t of this.tracks) {
      const r = this.buildTrak(t, delta, use64);
      traks.push(r.trak);
      if (r.duration > movieDuration) movieDuration = r.duration;
    }
    const now = Math.floor(Date.now() / 1000) + macEpoch;
    const mvhd = Buffer.alloc(96);
    mvhd.writeUInt32BE(now, 0);
    mvhd.writeUInt32BE(now, 4);
    mvhd.writeUInt32BE(1000, 8);
    mvhd.writeUInt32BE(Math.min(movieDuration, 0xffffffff), 12);
    mvhd.writeUInt32BE(0x00010000, 16);
    mvhd.writeUInt16BE(0x0100, 20);
    mvhd.writeUInt32BE(0x00010000, 32);
    mvhd.writeUInt32BE(0x00010000, 48);
    mvhd.writeUInt32BE(0x40000000, 64);
    mvhd.writeUInt32BE(this.tracks.length + 1, 92);
    const udta = buildMp4Meta(this.tags);
    const parts = [fullBox('mvhd', 0, 0, mvhd), ...traks];
    if (udta) parts.push(udta);
    return box('moov', ...parts);
  }

  maxOffset() {
    let max = 0;
    for (const t of this.tracks) {
      const offs = t.chunkOffsets.view();
      for (let i = 0; i < offs.length; i++) if (offs[i] > max) max = offs[i];
    }
    return max;
  }

  async finish() {
    for (const t of this.tracks) await this.flushChunk(t);
    const sink = this.sink;
    const dataStart = this.mdatStart + 16;
    const dataLen = sink.pos - dataStart;
    const large = dataLen + 8 > 0xffffffff;
    if (large) {
      const head = Buffer.alloc(16);
      head.writeUInt32BE(1, 0);
      head.write('mdat', 4, 'latin1');
      head.writeUInt32BE(Math.floor((dataLen + 16) / 4294967296), 8);
      head.writeUInt32BE((dataLen + 16) >>> 0, 12);
      await sink.writeAt(this.mdatStart, head);
    } else {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(dataLen + 8, 0);
      head.write('mdat', 4, 'latin1');
      await sink.writeAt(this.mdatStart + 8, head);
    }
    const maxOff = this.maxOffset();
    if (!this.faststart) {
      const use64 = maxOff > 0xffffffff;
      await sink.write(this.buildMoov(0, use64));
      return;
    }
    const oldStart = large ? this.mdatStart : this.mdatStart + 8;
    const regionLen = sink.pos - oldStart;
    let use64 = false;
    let moov = this.buildMoov(0, use64);
    for (let guard = 0; guard < 4; guard++) {
      const delta = moov.length - (large ? 0 : 8);
      const need64 = maxOff + delta > 0xffffffff;
      const next = this.buildMoov(delta, use64 || need64);
      const stable = next.length === moov.length && (use64 || need64) === use64;
      use64 = use64 || need64;
      moov = next;
      if (stable) break;
    }
    const shift = moov.length - (large ? 0 : 8);
    const buf = Buffer.allocUnsafe(chunkBytes);
    let end = oldStart + regionLen;
    while (end > oldStart) {
      const start = Math.max(oldStart, end - buf.length);
      const len = end - start;
      let got = 0;
      while (got < len) {
        const n = await sink.readAt(buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      await sink.writeAt(start + shift, buf.subarray(0, len));
      end = start;
    }
    await sink.writeAt(this.mdatStart, moov);
  }
}

export {
  Mp4Muxer,
};
