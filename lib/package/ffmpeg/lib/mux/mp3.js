import { noSupport, badArg } from '../errors.js';
import { parseMpaHeader, sideInfoSize } from '../codec/mpa.js';
import { buildId3 } from '../tags.js';

class Mp3Muxer {
  constructor(sink, options) {
    this.sink = sink;
    this.tags = options.tags || {};
    this.frames = 0;
    this.bytes = 0;
    this.first = null;
    this.infoPos = -1;
    this.infoOffset = 0;
    this.infoLen = 0;
    this.vbr = false;
    this.started = false;
    this.delay = 0;
    this.padding = 0;
  }

  static accepts(stream) {
    return stream.type === 'audio' && stream.codec === 'mp3';
  }

  async open(streams) {
    if (streams.length !== 1 || !Mp3Muxer.accepts(streams[0])) throw noSupport('mp3 output needs exactly one mp3 audio stream');
    this.delay = streams[0].encoderDelay || 0;
    this.padding = streams[0].encoderPadding || 0;
    const id3 = buildId3(this.tags);
    if (id3) await this.sink.write(id3);
  }

  async writeInfo(h, data) {
    if (h.layer !== 3) return;
    const offset = 4 + sideInfoSize(h);
    let len = h.frameLen - h.padding;
    if (len < offset + 16) return;
    if (this.delay || this.padding) len = Math.max(len, offset + 40);
    if (len > h.frameLen) return;
    const frame = Buffer.alloc(len);
    data.copy(frame, 0, 0, 4);
    frame[1] |= 1;
    frame[2] &= ~2;
    this.infoPos = this.sink.pos;
    this.infoOffset = offset;
    this.infoLen = len;
    await this.sink.write(frame);
  }

  async writePacket(index, packet) {
    if (index !== 0) throw badArg('mp3: invalid stream index');
    const data = packet.data;
    const h = parseMpaHeader(data, 0);
    if (!this.started) {
      this.started = true;
      this.first = h;
      if (h) await this.writeInfo(h, data);
    }
    if (h && this.first && h.bitrate !== this.first.bitrate) this.vbr = true;
    this.frames++;
    this.bytes += data.length;
    await this.sink.write(data);
  }

  async finish() {
    if (this.infoPos < 0) return;
    const lame = (this.delay || this.padding) && this.infoLen >= this.infoOffset + 40;
    const body = Buffer.alloc(lame ? 40 : 16);
    body.write(this.vbr ? 'Xing' : 'Info', 0, 'latin1');
    body.writeUInt32BE(3, 4);
    body.writeUInt32BE(this.frames, 8);
    body.writeUInt32BE(this.bytes + this.infoLen, 12);
    if (lame) {
      body.write('LAME3.100', 16, 'latin1');
      body[16 + 21] = (this.delay >> 4) & 0xff;
      body[16 + 22] = ((this.delay & 15) << 4) | ((this.padding >> 8) & 15);
      body[16 + 23] = this.padding & 0xff;
    }
    await this.sink.writeAt(this.infoPos + this.infoOffset, body);
  }
}

export {
  Mp3Muxer,
};
