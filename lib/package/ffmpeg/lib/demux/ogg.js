import { badData } from '../errors.js';
import { parseVorbisComment } from '../tags.js';
import { opusPacketDuration, parseOpusHead } from '../codec/opus.js';

class OggDemuxer {
  static probe(head) {
    return head.length >= 4 && head.toString('latin1', 0, 4) === 'OggS';
  }

  static async open(reader) {
    const demuxer = new OggDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'ogg';
    this.tags = {};
    this.streams = [];
    this.logical = new Map();
    this.queue = [];
    this.ready = false;
  }

  async readPage() {
    const r = this.reader;
    for (;;) {
      if (r.pos + 27 > r.size) return null;
      const h = await r.read(27);
      if (h[0] !== 0x4f || h[1] !== 0x67 || h[2] !== 0x67 || h[3] !== 0x53) {
        r.seek(r.pos - 26);
        continue;
      }
      const nsegs = h[26];
      const lacing = await r.read(nsegs);
      if (lacing.length < nsegs) return null;
      let size = 0;
      for (let i = 0; i < nsegs; i++) size += lacing[i];
      const body = await r.read(size);
      if (body.length < size) return null;
      const lo = h.readUInt32LE(6);
      const hi = h.readUInt32LE(10);
      return {
        flags: h[5],
        granule: lo === 0xffffffff && hi === 0xffffffff ? -1 : hi * 4294967296 + lo,
        serial: h.readUInt32LE(14),
        lacing,
        body,
      };
    }
  }

  async init() {
    let page;
    let pages = 0;
    while ((page = await this.readPage())) {
      pages++;
      this.handlePage(page);
      if (this.allReady()) break;
      if (pages > 4096) break;
    }
    if (!this.logical.size) throw badData('ogg: no logical streams');
    const groups = [...this.logical.values()].filter((s) => s.kind);
    if (!groups.length) throw badData('ogg: no supported streams');
    await this.findEnd();
    let index = 0;
    for (const st of groups) {
      st.index = index;
      let duration;
      if (st.endGranule > 0) {
        duration = st.kind === 'opus' ? Math.max(0, st.endGranule - st.preSkip) / 48000 : st.endGranule / st.sampleRate;
      }
      st.duration = duration;
      const stream = {
        index: index++,
        type: 'audio',
        codec: st.kind,
        timeScale: st.kind === 'opus' ? 48000 : st.sampleRate,
        sampleRate: st.kind === 'opus' ? 48000 : st.sampleRate,
        channels: st.channels,
        bitRate: st.bitRate,
        duration,
        extradata: st.headers[0],
        headers: st.headers,
        preSkip: st.preSkip,
        tags: st.tags,
      };
      if (st.kind === 'opus') stream.inputRate = st.inputRate;
      this.streams.push(stream);
      st.stream = stream;
      Object.assign(this.tags, st.tags);
    }
    this.duration = Math.max(...this.streams.map((s) => s.duration || 0)) || undefined;
    this.ready = true;
  }

  allReady() {
    for (const st of this.logical.values()) {
      if (st.kind && st.headers.length < st.need) return false;
    }
    return this.logical.size > 0 && [...this.logical.values()].every((s) => s.bos === false || !s.kind || s.headers.length >= s.need) && this.sawNonBos;
  }

  handlePage(page) {
    let st = this.logical.get(page.serial);
    if (!st) {
      if (this.ready || (this.sawNonBos && !(page.flags & 2))) return;
      st = { serial: page.serial, partial: [], kind: null, headers: [], need: 0, lastGranule: 0, position: 0, tags: {}, bos: true };
      this.logical.set(page.serial, st);
    }
    if (!(page.flags & 2)) this.sawNonBos = true;
    const packets = [];
    let off = 0;
    let acc = [];
    if (!(page.flags & 1)) st.partial = [];
    for (let i = 0; i < page.lacing.length; i++) {
      const len = page.lacing[i];
      acc.push(page.body.subarray(off, off + len));
      off += len;
      if (len < 255) {
        const cont = st.partial.length ? st.partial.concat(acc) : acc;
        packets.push(cont.length === 1 ? cont[0] : Buffer.concat(cont));
        st.partial = [];
        acc = [];
      }
    }
    if (acc.length) st.partial = st.partial.concat(acc);
    const audio = [];
    for (const pkt of packets) {
      if (!st.kind && st.headers.length === 0 && !st.probed) {
        st.probed = true;
        this.identify(st, pkt);
        continue;
      }
      if (!st.kind) continue;
      if (st.headers.length < st.need) {
        st.headers.push(pkt);
        if (st.headers.length === 2) this.readTags(st, pkt);
        continue;
      }
      audio.push(pkt);
    }
    if (st.kind && audio.length) this.queueAudio(st, audio, page);
    if (page.flags & 4 && page.granule >= 0 && st.kind) {
      st.endGranule = Math.max(st.endGranule || 0, page.granule);
      if (st.kind === 'opus' && audio.length) {
        const excess = st.position - page.granule;
        const last = this.queue[this.queue.length - 1];
        if (excess > 0 && last && last.stream === st.index) {
          const cut = Math.min(excess, last.duration);
          last.duration -= cut;
          st.position -= cut;
        }
      }
    }
    if (page.granule >= 0) st.lastGranule = page.granule;
  }

  identify(st, pkt) {
    if (pkt.length >= 19 && pkt.toString('latin1', 0, 8) === 'OpusHead') {
      const head = parseOpusHead(pkt);
      st.kind = 'opus';
      st.need = 2;
      st.channels = head.channels;
      st.preSkip = head.preSkip;
      st.inputRate = head.inputRate;
      st.sampleRate = 48000;
      st.headers.push(pkt);
    } else if (pkt.length >= 30 && pkt[0] === 1 && pkt.toString('latin1', 1, 7) === 'vorbis') {
      st.kind = 'vorbis';
      st.need = 3;
      st.channels = pkt[11];
      st.sampleRate = pkt.readUInt32LE(12);
      const nominal = pkt.readInt32LE(20);
      st.bitRate = nominal > 0 ? nominal : undefined;
      st.preSkip = 0;
      st.headers.push(pkt);
    }
  }

  readTags(st, pkt) {
    try {
      if (st.kind === 'opus' && pkt.toString('latin1', 0, 8) === 'OpusTags') st.tags = parseVorbisComment(pkt, 8);
      else if (st.kind === 'vorbis' && pkt[0] === 3) st.tags = parseVorbisComment(pkt, 7);
    } catch (e) {
      st.tags = {};
    }
  }

  queueAudio(st, audio, page) {
    if (st.kind === 'opus') {
      for (const data of audio) {
        const duration = opusPacketDuration(data);
        this.queue.push({ stream: st.index, pts: st.position, dts: st.position, duration, key: true, data });
        st.position += duration;
      }
      return;
    }
    let total = 0;
    if (page.granule >= 0 && page.lacing.length > 0) total = Math.max(0, page.granule - st.position);
    const count = audio.length;
    const base = Math.floor(total / count);
    for (let i = 0; i < count; i++) {
      const duration = i === count - 1 ? total - base * (count - 1) : base;
      this.queue.push({ stream: st.index, pts: st.position, dts: st.position, duration, key: true, data: audio[i] });
      st.position += duration;
    }
  }

  async findEnd() {
    const r = this.reader;
    const save = r.pos;
    const span = Math.min(r.size, 131072);
    r.seek(r.size - span);
    const tail = await r.read(span);
    r.seek(save);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
        const lo = tail.readUInt32LE(i + 6);
        const hi = tail.readUInt32LE(i + 10);
        if (lo === 0xffffffff && hi === 0xffffffff) continue;
        const serial = tail.readUInt32LE(i + 14);
        const st = this.logical.get(serial);
        if (st && st.kind) {
          st.endGranule = hi * 4294967296 + lo;
          return;
        }
      }
    }
  }

  async readPacket() {
    while (!this.queue.length) {
      const page = await this.readPage();
      if (!page) return null;
      this.handlePage(page);
    }
    const pkt = this.queue.shift();
    return pkt;
  }

  async close() {
    await this.reader.close();
  }
}

export {
  OggDemuxer,
};
