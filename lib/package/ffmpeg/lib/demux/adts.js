import { badData } from '../errors.js';
import { parseId3, id3Size } from '../tags.js';

const adtsSampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAdtsHeader(buf, off) {
  if (off + 7 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xf6) !== 0xf0) return null;
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];
  const sfi = (b2 >> 2) & 15;
  if (sfi > 12) return null;
  const chan = ((b2 & 1) << 2) | (b3 >> 6);
  const frameLen = ((b3 & 3) << 11) | (buf[off + 4] << 3) | (buf[off + 5] >> 5);
  const headerLen = b1 & 1 ? 7 : 9;
  if (frameLen < headerLen) return null;
  return {
    mpeg2: ((b1 >> 3) & 1) === 1,
    profile: (b2 >> 6) & 3,
    sfi,
    sampleRate: adtsSampleRates[sfi],
    chan,
    channels: [0, 1, 2, 3, 4, 5, 6, 8][chan] || 0,
    frameLen,
    headerLen,
    blocks: (buf[off + 6] & 3) + 1,
  };
}

function buildAsc(profile, sfi, chan) {
  const aot = profile + 1;
  return Buffer.from([(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (chan << 3)]);
}

class AdtsDemuxer {
  static probe(head) {
    const h = parseAdtsHeader(head, 0);
    return Boolean(h);
  }

  static async open(reader) {
    const demuxer = new AdtsDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'adts';
    this.tags = {};
    this.streams = [];
    this.index = 0;
  }

  async init() {
    const r = this.reader;
    for (;;) {
      const head = await r.peek(10);
      const size = id3Size(head);
      if (!size) break;
      Object.assign(this.tags, parseId3(await r.readExact(size)));
    }
    let pos = r.pos;
    let found = null;
    const limit = Math.min(r.size, pos + (1 << 20));
    while (!found && pos + 7 <= limit) {
      r.seek(pos);
      const chunk = await r.read(Math.min(65536, limit - pos));
      for (let i = 0; i + 7 <= chunk.length && !found; i++) {
        if (chunk[i] !== 0xff) continue;
        const h = parseAdtsHeader(chunk, i);
        if (!h) continue;
        r.seek(pos + i + h.frameLen);
        const next = await r.read(7);
        if ((next.length >= 7 && parseAdtsHeader(next, 0)) || pos + i + h.frameLen >= r.size) found = { pos: pos + i, header: h };
      }
      pos += Math.max(1, chunk.length - 6);
    }
    if (!found) throw badData('adts: no valid frame found');
    this.ref = found.header;
    this.pos = found.pos;
    this.audioStart = found.pos;
    this.estimated = true;
    const h = this.ref;
    const avgBits = (h.frameLen * 8 * h.sampleRate) / (1024 * h.blocks);
    this.duration = ((r.size - this.audioStart) * 8) / avgBits;
    this.streams.push({
      index: 0,
      type: 'audio',
      codec: 'aac',
      timeScale: h.sampleRate,
      sampleRate: h.sampleRate,
      channels: h.channels,
      bitRate: Math.round(avgBits),
      duration: this.duration,
      extradata: buildAsc(h.profile, h.sfi, h.chan),
    });
  }

  async scanDuration() {
    if (!this.estimated) return this.duration;
    const r = this.reader;
    let pos = this.audioStart;
    let frames = 0;
    while (pos + 7 <= r.size) {
      r.seek(pos);
      const head = await r.read(7);
      const h = parseAdtsHeader(head, 0);
      if (h && h.sfi === this.ref.sfi) {
        frames += h.blocks;
        pos += h.frameLen;
      } else pos++;
    }
    this.duration = (frames * 1024) / this.ref.sampleRate;
    this.streams[0].duration = this.duration;
    this.estimated = false;
    return this.duration;
  }

  async readPacket() {
    const r = this.reader;
    for (;;) {
      if (this.pos + 7 > r.size) return null;
      r.seek(this.pos);
      const head = await r.read(9);
      const h = parseAdtsHeader(head, 0);
      if (h && h.sfi === this.ref.sfi && h.chan === this.ref.chan) {
        if (this.pos + h.frameLen > r.size) return null;
        r.seek(this.pos + h.headerLen);
        const data = await r.read(h.frameLen - h.headerLen);
        this.pos += h.frameLen;
        const pts = this.index * 1024;
        const duration = 1024 * h.blocks;
        this.index += h.blocks;
        return { stream: 0, pts, dts: pts, duration, key: true, data };
      }
      this.pos++;
    }
  }

  async close() {
    await this.reader.close();
  }
}

export {
  AdtsDemuxer,
  parseAdtsHeader,
  adtsSampleRates,
};
