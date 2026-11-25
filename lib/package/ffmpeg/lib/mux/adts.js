import { noSupport, badArg } from '../errors.js';
import { adtsSampleRates } from '../demux/adts.js';

function parseAsc(asc) {
  if (!asc || asc.length < 2) throw noSupport('adts: missing audio specific config');
  let bits = 0;
  let pos = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[pos >> 3] || 0;
      v = v * 2 + ((byte >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  let sfi = read(4);
  if (sfi === 15) {
    const rate = read(24);
    sfi = adtsSampleRates.indexOf(rate);
    if (sfi < 0) throw noSupport('adts: unsupported sample rate');
  }
  const chan = read(4);
  if (aot === 5 || aot === 29) {
    let ext = read(4);
    if (ext === 15) read(24);
    aot = read(5);
    if (aot === 31) aot = 32 + read(6);
  }
  bits = aot;
  return { aot: bits, sfi, chan };
}

class AdtsMuxer {
  constructor(sink, options) {
    this.sink = sink;
    this.cfg = null;
  }

  static accepts(stream) {
    return stream.type === 'audio' && stream.codec === 'aac';
  }

  async open(streams) {
    if (streams.length !== 1 || !AdtsMuxer.accepts(streams[0])) throw noSupport('adts output needs exactly one aac audio stream');
    this.cfg = parseAsc(streams[0].extradata);
    if (this.cfg.aot < 1 || this.cfg.aot > 4) throw noSupport('adts: unsupported audio object type ' + this.cfg.aot);
  }

  async writePacket(index, packet) {
    if (index !== 0) throw badArg('adts: invalid stream index');
    const len = packet.data.length + 7;
    if (len > 0x1fff) throw noSupport('adts: frame too large');
    const c = this.cfg;
    const head = Buffer.alloc(7);
    head[0] = 0xff;
    head[1] = 0xf1;
    head[2] = ((c.aot - 1) << 6) | (c.sfi << 2) | (c.chan >> 2);
    head[3] = ((c.chan & 3) << 6) | ((len >> 11) & 3);
    head[4] = (len >> 3) & 0xff;
    head[5] = ((len & 7) << 5) | 0x1f;
    head[6] = 0xfc;
    await this.sink.write(head);
    await this.sink.write(packet.data);
  }

  async finish() {}
}

export {
  AdtsMuxer,
  parseAsc,
};
