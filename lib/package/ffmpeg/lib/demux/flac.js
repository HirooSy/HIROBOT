import { badData } from '../errors.js';
import { parseStreamInfo, parseFrameHeader } from '../codec/flac.js';
import { crc16Table } from '../crc.js';
import { parseVorbisComment, parseId3, id3Size } from '../tags.js';

class FlacDemuxer {
  static probe(head) {
    return head.length >= 4 && head.toString('latin1', 0, 4) === 'fLaC';
  }

  static async open(reader) {
    const demuxer = new FlacDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'flac';
    this.tags = {};
    this.streams = [];
    this.buf = Buffer.allocUnsafe(1 << 17);
    this.start = 0;
    this.end = 0;
    this.eof = false;
    this.table = crc16Table();
  }

  async init() {
    const r = this.reader;
    const head = await r.peek(10);
    const skip = id3Size(head);
    if (skip > 0) {
      const tag = await r.readExact(skip);
      Object.assign(this.tags, parseId3(tag));
    }
    const magic = await r.readExact(4);
    if (magic.toString('latin1') !== 'fLaC') throw badData('flac: missing marker');
    let info = null;
    let streamInfoBuf = null;
    let last = false;
    while (!last) {
      const h = await r.readExact(4);
      last = (h[0] & 0x80) !== 0;
      const type = h[0] & 0x7f;
      const len = h.readUIntBE(1, 3);
      const body = await r.readExact(len);
      if (type === 0) {
        streamInfoBuf = body.subarray(0, 34);
        info = parseStreamInfo(body);
      } else if (type === 4) {
        let parsed = null;
        try {
          parsed = parseVorbisComment(body);
        } catch (e) {
          parsed = null;
        }
        if (parsed) Object.assign(this.tags, parsed);
      }
    }
    if (!info) throw badData('flac: missing streaminfo');
    this.info = info;
    this.dataStart = r.pos;
    const duration = info.totalSamples > 0 ? info.totalSamples / info.sampleRate : undefined;
    this.streams.push({
      index: 0,
      type: 'audio',
      codec: 'flac',
      timeScale: info.sampleRate,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bitsPerSample: info.bitsPerSample,
      bitRate: duration ? Math.round(((r.size - this.dataStart) * 8) / duration) : undefined,
      duration,
      frames: info.totalSamples,
      extradata: Buffer.from(streamInfoBuf),
    });
    this.duration = duration;
  }

  async fillMore() {
    if (this.start > 0) {
      this.buf.copy(this.buf, 0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
    }
    if (this.end === this.buf.length) {
      const next = Buffer.allocUnsafe(this.buf.length * 2);
      this.buf.copy(next, 0, 0, this.end);
      this.buf = next;
    }
    const got = await this.reader.readInto(this.buf, this.end, Math.min(this.buf.length - this.end, 1 << 16));
    if (got === 0) this.eof = true;
    else this.end += got;
  }

  async ensure(n) {
    while (this.end - this.start < n && !this.eof) await this.fillMore();
    return this.end - this.start >= n;
  }

  async readPacket() {
    await this.ensure(32);
    if (this.end - this.start < 6) return null;
    let hdr = parseFrameHeader(this.buf, this.start, this.end, this.info);
    while (!hdr) {
      this.start++;
      await this.ensure(32);
      if (this.end - this.start < 6) return null;
      hdr = parseFrameHeader(this.buf, this.start, this.end, this.info);
    }
    const table = this.table;
    let off = hdr.headerLen + 3;
    let crc = 0;
    {
      const b = this.buf;
      for (let i = this.start; i < this.start + off; i++) crc = ((crc << 8) & 0xffff) ^ table[(crc >>> 8) ^ b[i]];
    }
    for (;;) {
      const avail = this.end - this.start;
      const safe = this.eof ? avail : avail - 16;
      const b = this.buf;
      const base = this.start;
      while (off <= safe) {
        if (off === avail) break;
        const byte = b[base + off];
        if (crc === 0 && byte === 0xff && parseFrameHeader(b, base + off, this.end, this.info)) return this.emit(off, hdr);
        crc = ((crc << 8) & 0xffff) ^ table[(crc >>> 8) ^ byte];
        off++;
      }
      if (this.eof && off >= avail) return this.emit(avail, hdr);
      await this.fillMore();
    }
  }

  emit(len, hdr) {
    const data = Buffer.from(this.buf.subarray(this.start, this.start + len));
    this.start += len;
    const pts = hdr.variable ? hdr.number : hdr.number * this.info.minBlockSize;
    return { stream: 0, pts, dts: pts, duration: hdr.blockSize, key: true, data };
  }

  async close() {
    await this.reader.close();
  }
}

export {
  FlacDemuxer,
};
