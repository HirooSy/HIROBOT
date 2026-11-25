import { noSupport, badArg } from '../errors.js';
import { parseStreamInfo, buildStreamInfo, parseFrameHeader, utf8Number } from '../codec/flac.js';
import { crc8, crc16 } from '../crc.js';
import { buildVorbisComment } from '../tags.js';

class FlacMuxer {
  constructor(sink, options) {
    this.sink = sink;
    this.tags = options.tags || {};
    this.info = null;
    this.samples = 0;
    this.frames = 0;
    this.minFrame = 0;
    this.maxFrame = 0;
  }

  static accepts(stream) {
    return stream.type === 'audio' && stream.codec === 'flac';
  }

  async open(streams) {
    if (streams.length !== 1 || !FlacMuxer.accepts(streams[0])) throw noSupport('flac output needs exactly one flac audio stream');
    const s = streams[0];
    this.info = parseStreamInfo(s.extradata);
    this.variable = this.info.minBlockSize !== this.info.maxBlockSize;
    const hasTags = Object.keys(this.tags).length > 0;
    const parts = [Buffer.from('fLaC', 'latin1')];
    const head = Buffer.alloc(4);
    head[0] = hasTags ? 0 : 0x80;
    head.writeUIntBE(34, 1, 3);
    parts.push(head, buildStreamInfo(this.info));
    if (hasTags) {
      const body = buildVorbisComment(this.tags);
      const h = Buffer.alloc(4);
      h[0] = 0x84;
      h.writeUIntBE(body.length, 1, 3);
      parts.push(h, body);
    }
    await this.sink.write(Buffer.concat(parts));
  }

  async writePacket(index, packet) {
    if (index !== 0) throw badArg('flac: invalid stream index');
    let data = packet.data;
    const hdr = parseFrameHeader(data, 0, data.length, this.info);
    if (hdr) {
      const expected = this.variable ? this.samples : this.frames;
      if (hdr.number !== expected) data = this.renumber(data, hdr, expected);
    }
    const dur = hdr ? hdr.blockSize : packet.duration;
    this.samples += dur;
    this.frames++;
    if (this.minFrame === 0 || data.length < this.minFrame) this.minFrame = data.length;
    if (data.length > this.maxFrame) this.maxFrame = data.length;
    await this.sink.write(data);
  }

  renumber(data, hdr, number) {
    const oldNum = utf8Number(hdr.number).length;
    const extras = data.subarray(4 + oldNum, hdr.headerLen - 1);
    const head = Buffer.concat([data.subarray(0, 4), utf8Number(number), extras]);
    const out = Buffer.concat([head, Buffer.from([crc8(head, 0, head.length)]), data.subarray(hdr.headerLen, data.length - 2), Buffer.alloc(2)]);
    out.writeUInt16BE(crc16(out, 0, out.length - 2), out.length - 2);
    return out;
  }

  async finish() {
    const info = Object.assign({}, this.info, {
      minFrameSize: this.minFrame,
      maxFrameSize: this.maxFrame,
      totalSamples: this.samples,
    });
    await this.sink.writeAt(8, buildStreamInfo(info));
  }
}

export {
  FlacMuxer,
};
