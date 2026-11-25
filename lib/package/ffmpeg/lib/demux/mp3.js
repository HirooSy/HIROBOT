import { badData } from '../errors.js';
import { parseMpaHeader, sideInfoSize } from '../codec/mpa.js';
import { parseId3, id3Size } from '../tags.js';


class Mp3Demuxer {
  static probe(head) {
    if (head.length < 4) return false;
    const h = parseMpaHeader(head, 0);
    return Boolean(h);
  }

  static async open(reader) {
    const demuxer = new Mp3Demuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'mp3';
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
      const tag = await r.readExact(size);
      Object.assign(this.tags, parseId3(tag));
    }
    this.end = r.size;
    if (r.size >= 128) {
      const save = r.pos;
      r.seek(r.size - 128);
      const tail = await r.read(3);
      r.seek(save);
      if (tail.toString('latin1') === 'TAG') this.end = r.size - 128;
    }
    const first = await this.findFirst();
    if (!first) throw badData('mp3: no valid frame found');
    const h = first.header;
    this.ref = h;
    this.pos = first.pos;
    this.audioStart = first.pos;
    r.seek(first.pos);
    const frame = await r.read(h.frameLen);
    let xingFrames = 0;
    let vbr = false;
    let delay = 0;
    let padding = 0;
    let lame = false;
    const xo = 4 + (h.protection ? 2 : 0) + (h.layer === 3 ? sideInfoSize(h) : 0);
    if (h.layer === 3 && frame.length >= xo + 8) {
      const tag = frame.toString('latin1', xo, xo + 4);
      if (tag === 'Xing' || tag === 'Info') {
        vbr = tag === 'Xing';
        const flags = frame.readUInt32BE(xo + 4);
        let q = xo + 8;
        if (flags & 1) {
          xingFrames = frame.readUInt32BE(q);
          q += 4;
        }
        if (flags & 2) q += 4;
        if (flags & 4) q += 100;
        if (flags & 8) q += 4;
        if (frame.length >= q + 24 && /^(LAME|Lavf|Lavc)/.test(frame.toString('latin1', q, q + 4))) {
          lame = true;
          delay = (frame[q + 21] << 4) | (frame[q + 22] >> 4);
          padding = ((frame[q + 22] & 15) << 8) | frame[q + 23];
        }
        this.pos += h.frameLen;
        this.audioStart = this.pos;
      } else if (frame.length >= 50 && frame.toString('latin1', 36, 40) === 'VBRI') {
        vbr = true;
        xingFrames = frame.readUInt32BE(50);
        this.pos += h.frameLen;
        this.audioStart = this.pos;
      }
    }
    const spf = h.samples;
    let duration;
    let bitRate = h.bitrate;
    if (xingFrames > 0) {
      duration = (xingFrames * spf) / h.sampleRate;
      bitRate = Math.round(((this.end - this.audioStart) * 8) / duration);
    } else if (!vbr) {
      duration = ((this.end - this.audioStart) * 8) / h.bitrate;
    }
    this.estimated = xingFrames === 0;
    this.duration = duration;
    this.streams.push({
      index: 0,
      type: 'audio',
      codec: { 1: 'mp1', 2: 'mp2', 3: 'mp3' }[h.layer],
      timeScale: h.sampleRate,
      sampleRate: h.sampleRate,
      channels: h.channels,
      bitRate,
      duration,
      extradata: null,
      encoderDelay: delay,
      encoderPadding: padding,
      samplesPerFrame: spf,
      gapless: lame ? { delay, padding, frames: xingFrames } : undefined,
    });
  }

  async findFirst() {
    const r = this.reader;
    const limit = Math.min(r.size, r.pos + (1 << 20));
    let pos = r.pos;
    while (pos + 4 <= limit) {
      r.seek(pos);
      const chunk = await r.read(Math.min(65536, limit - pos));
      if (chunk.length < 4) break;
      for (let i = 0; i + 4 <= chunk.length; i++) {
        if (chunk[i] !== 0xff) continue;
        const h = parseMpaHeader(chunk, i);
        if (!h) continue;
        const at = pos + i;
        if (await this.confirm(at, h)) return { pos: at, header: h };
      }
      pos += Math.max(1, chunk.length - 3);
    }
    return null;
  }

  async confirm(at, h) {
    const r = this.reader;
    let p = at;
    let cur = h;
    for (let n = 0; n < 3; n++) {
      p += cur.frameLen;
      if (p + 4 > r.size) return p === r.size || p === this.end;
      r.seek(p);
      const buf = await r.read(4);
      const next = parseMpaHeader(buf, 0);
      if (!next || next.layer !== h.layer || next.sampleRate !== h.sampleRate || next.versionBits !== h.versionBits) return false;
      cur = next;
    }
    return true;
  }

  async scanDuration() {
    if (!this.estimated) return this.duration;
    const r = this.reader;
    const save = this.pos;
    let pos = this.audioStart;
    let frames = 0;
    while (pos + 4 <= this.end) {
      r.seek(pos);
      const buf = await r.read(4);
      const h = parseMpaHeader(buf, 0);
      if (h && h.sampleRate === this.ref.sampleRate && h.layer === this.ref.layer) {
        frames++;
        pos += h.frameLen;
      } else pos++;
    }
    this.pos = save;
    this.duration = (frames * this.ref.samples) / this.ref.sampleRate;
    this.streams[0].duration = this.duration;
    this.estimated = false;
    return this.duration;
  }

  async readPacket() {
    const r = this.reader;
    const ref = this.ref;
    for (;;) {
      if (this.pos + 4 > this.end) return null;
      r.seek(this.pos);
      const head = await r.read(4);
      const h = parseMpaHeader(head, 0);
      if (h && h.layer === ref.layer && h.sampleRate === ref.sampleRate && h.versionBits === ref.versionBits) {
        if (this.pos + h.frameLen > this.end) return null;
        r.seek(this.pos);
        const data = await r.read(h.frameLen);
        this.pos += h.frameLen;
        const pts = this.index * ref.samples;
        this.index++;
        return { stream: 0, pts, dts: pts, duration: ref.samples, key: true, data, bitrate: h.bitrate };
      }
      this.pos++;
    }
  }

  async close() {
    await this.reader.close();
  }
}

export {
  Mp3Demuxer,
};
