import { badArg, noSupport } from '../errors.js';
import { formats } from '../codec/pcm.js';
import { buildRiffInfo } from '../tags.js';


const subTagMap = { pcm_u8: 1, pcm_s16le: 1, pcm_s24le: 1, pcm_s32le: 1, pcm_f32le: 3, pcm_f64le: 3, pcm_alaw: 6, pcm_mulaw: 7 };

class WavMuxer {
  constructor(sink, options) {
    this.sink = sink;
    this.tags = options.tags || {};
    this.dataBytes = 0;
    this.dataPos = 0;
    this.factPos = -1;
    this.frames = 0;
    this.blockAlign = 0;
  }

  static accepts(stream) {
    return stream.type === 'audio' && Object.prototype.hasOwnProperty.call(subTagMap, stream.codec);
  }

  async open(streams) {
    if (streams.length !== 1 || !WavMuxer.accepts(streams[0])) throw noSupport('wav output needs exactly one pcm audio stream');
    const s = streams[0];
    const info = formats[s.codec];
    const tag = subTagMap[s.codec];
    const bits = info.bits;
    this.blockAlign = s.channels * info.bytes;
    const extensible = (tag === 1 || tag === 3) && (s.channels > 2 || s.sampleRate > 48000 || bits > 16);
    const fmtSize = extensible ? 40 : 16;
    const fmt = Buffer.alloc(8 + fmtSize);
    fmt.write('fmt ', 0, 'latin1');
    fmt.writeUInt32LE(fmtSize, 4);
    fmt.writeUInt16LE(extensible ? 0xfffe : tag, 8);
    fmt.writeUInt16LE(s.channels, 10);
    fmt.writeUInt32LE(s.sampleRate, 12);
    fmt.writeUInt32LE(s.sampleRate * this.blockAlign, 16);
    fmt.writeUInt16LE(this.blockAlign, 20);
    fmt.writeUInt16LE(bits, 22);
    if (extensible) {
      fmt.writeUInt16LE(22, 24);
      fmt.writeUInt16LE(bits, 26);
      fmt.writeUInt32LE({ 1: 0x4, 2: 0x3, 3: 0x7, 4: 0x33, 5: 0x37, 6: 0x3f, 7: 0x13f, 8: 0x63f }[s.channels] || 0, 28);
      fmt.writeUInt16LE(tag, 32);
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(fmt, 34);
    }
    const parts = [Buffer.alloc(12), fmt];
    if (tag !== 1) {
      const fact = Buffer.alloc(12);
      fact.write('fact', 0, 'latin1');
      fact.writeUInt32LE(4, 4);
      parts.push(fact);
      this.factPos = parts.reduce((n, b) => n + b.length, 0) - 4;
    }
    const list = buildRiffInfo(this.tags);
    if (list) parts.push(list);
    const dataHead = Buffer.alloc(8);
    dataHead.write('data', 0, 'latin1');
    parts.push(dataHead);
    const head = Buffer.concat(parts);
    head.write('RIFF', 0, 'latin1');
    head.write('WAVE', 8, 'latin1');
    this.dataPos = head.length - 4;
    await this.sink.write(head);
  }

  async writePacket(index, packet) {
    if (index !== 0) throw badArg('wav: invalid stream index');
    this.dataBytes += packet.data.length;
    await this.sink.write(packet.data);
  }

  async finish() {
    if (this.dataBytes > 0xfffffff0) throw noSupport('wav: output exceeds 4 GiB');
    if (this.dataBytes & 1) await this.sink.write(Buffer.from([0]));
    const total = this.sink.pos;
    const size = Buffer.alloc(4);
    size.writeUInt32LE(total - 8, 0);
    await this.sink.writeAt(4, size);
    const data = Buffer.alloc(4);
    data.writeUInt32LE(this.dataBytes, 0);
    await this.sink.writeAt(this.dataPos, data);
    if (this.factPos >= 0) {
      const fact = Buffer.alloc(4);
      fact.writeUInt32LE(Math.floor(this.dataBytes / this.blockAlign), 0);
      await this.sink.writeAt(this.factPos, fact);
    }
  }
}

export {
  WavMuxer,
};
