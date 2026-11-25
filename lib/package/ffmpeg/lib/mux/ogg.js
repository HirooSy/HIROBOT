import { noSupport, badArg } from '../errors.js';
import { crc32ogg } from '../crc.js';
import { buildVorbisComment } from '../tags.js';
import { parseOpusHead } from '../codec/opus.js';

class OggMuxer {
  constructor(sink, options) {
    this.sink = sink;
    this.tags = options.tags || {};
    this.serial = (Math.random() * 4294967296) >>> 0;
    this.seq = 0;
    this.queue = [];
    this.queueSegs = 0;
    this.queueBytes = 0;
    this.queueDur = 0;
    this.position = 0;
    this.stream = null;
    this.continued = false;
    this.preSkip = 0;
    this.scale = 1;
  }

  static accepts(stream) {
    return stream.type === 'audio' && (stream.codec === 'opus' || (stream.codec === 'vorbis' && stream.headers && stream.headers.length === 3));
  }

  async open(streams) {
    if (streams.length !== 1 || !OggMuxer.accepts(streams[0])) throw noSupport('ogg output needs exactly one opus or vorbis audio stream');
    const s = streams[0];
    this.stream = s;
    if (s.codec === 'opus') {
      const head = s.headers ? s.headers[0] : s.extradata;
      const info = parseOpusHead(head);
      if (!info) throw noSupport('ogg: invalid opus header');
      this.preSkip = info.preSkip;
      this.scale = 48000 / s.timeScale;
      const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), buildVorbisComment(this.tags)]);
      await this.writeRaw([head], 0, 2, true);
      await this.writeRaw([tags], 0, 0, false);
    } else {
      this.scale = 1;
      const comment = Buffer.concat([Buffer.from([3]), Buffer.from('vorbis', 'latin1'), buildVorbisComment(this.tags), Buffer.from([1])]);
      await this.writeRaw([s.headers[0]], 0, 2, true);
      await this.writeRaw([comment, s.headers[2]], 0, 0, false);
    }
  }

  async writeRaw(packets, granule, flags, flush, continued) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    }
    return this.writePage(packets, lacing, granule, flags);
  }

  async writePage(packets, lacing, granule, flags) {
    const bodyLen = packets.reduce((n, p) => n + p.length, 0);
    const head = Buffer.alloc(27 + lacing.length);
    head.write('OggS', 0, 'latin1');
    head[5] = flags;
    if (granule < 0) head.fill(0xff, 6, 14);
    else {
      head.writeUInt32LE(granule % 4294967296, 6);
      head.writeUInt32LE(Math.floor(granule / 4294967296), 10);
    }
    head.writeUInt32LE(this.serial, 14);
    head.writeUInt32LE(this.seq++, 18);
    head[26] = lacing.length;
    for (let i = 0; i < lacing.length; i++) head[27 + i] = lacing[i];
    const body = packets.length === 1 ? packets[0] : Buffer.concat(packets, bodyLen);
    let crc = crc32ogg(head, 0, head.length);
    crc = crc32ogg(body, 0, body.length, crc);
    head.writeUInt32LE(crc, 22);
    await this.sink.write(head);
    await this.sink.write(body);
  }

  granuleFor(position) {
    return position;
  }

  async flushQueue(eos) {
    if (!this.queue.length && !eos) return;
    const packets = [];
    const lacing = [];
    for (const p of this.queue) {
      packets.push(p);
      let n = p.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    }
    const flags = (this.continued ? 1 : 0) | (eos ? 4 : 0);
    await this.writePage(packets, lacing, this.granuleFor(this.position), flags);
    this.continued = false;
    this.queue = [];
    this.queueSegs = 0;
    this.queueBytes = 0;
    this.queueDur = 0;
  }

  async writePacket(index, packet) {
    if (index !== 0) throw badArg('ogg: invalid stream index');
    let data = packet.data;
    const duration = Math.round((packet.duration || 0) * this.scale);
    let segs = Math.floor(data.length / 255) + 1;
    if (segs > 255) {
      await this.flushQueue(false);
      let off = 0;
      let first = true;
      while (data.length - off >= 255 * 255) {
        const piece = data.subarray(off, off + 255 * 255);
        const lacing = new Array(255).fill(255);
        const head = first ? 0 : 1;
        await this.writePage([piece], lacing, -1, head);
        off += 255 * 255;
        first = false;
      }
      data = data.subarray(off);
      this.continued = !first;
      segs = Math.floor(data.length / 255) + 1;
    } else if (this.queueSegs + segs > 255) await this.flushQueue(false);
    this.queue.push(data);
    this.queueSegs += segs;
    this.queueBytes += data.length;
    this.queueDur += duration;
    this.position += duration;
    const second = this.stream.codec === 'opus' ? 48000 : this.stream.timeScale;
    if (this.queueDur >= second || this.queueBytes >= 32768) await this.flushQueue(false);
  }

  async finish() {
    await this.flushQueue(true);
  }
}

export {
  OggMuxer,
};
