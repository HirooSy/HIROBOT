import { badData } from '../errors.js';
import { formats, pcmCodecForBits } from '../codec/pcm.js';
import { parseRiffInfo } from '../tags.js';
import { readU64LE } from '../util.js';


function codecFromTag(tag, bits) {
  switch (tag) {
    case 1:
      return pcmCodecForBits(bits, false);
    case 3:
      return bits > 32 ? 'pcm_f64le' : 'pcm_f32le';
    case 6:
      return 'pcm_alaw';
    case 7:
      return 'pcm_mulaw';
    default:
      return 'wav_0x' + tag.toString(16);
  }
}

class WavDemuxer {
  static probe(head) {
    return head.length >= 12 && (head.toString('latin1', 0, 4) === 'RIFF' || head.toString('latin1', 0, 4) === 'RF64') && head.toString('latin1', 8, 12) === 'WAVE';
  }

  static async open(reader) {
    const demuxer = new WavDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'wav';
    this.tags = {};
    this.streams = [];
    this.cursor = 0;
    this.dataStart = 0;
    this.dataEnd = 0;
    this.blockAlign = 0;
  }

  async init() {
    const r = this.reader;
    const head = await r.readExact(12);
    const rf64 = head.toString('latin1', 0, 4) === 'RF64';
    let fmt = null;
    let dataSize64 = -1;
    let found = false;
    while (r.remaining >= 8) {
      const chunk = await r.readExact(8);
      const id = chunk.toString('latin1', 0, 4);
      let size = chunk.readUInt32LE(4);
      const body = r.pos;
      if (id === 'fmt ') {
        const buf = await r.readExact(Math.min(size, 40));
        const tagRaw = buf.readUInt16LE(0);
        fmt = {
          tag: tagRaw,
          channels: buf.readUInt16LE(2),
          sampleRate: buf.readUInt32LE(4),
          byteRate: buf.readUInt32LE(8),
          blockAlign: buf.readUInt16LE(12),
          bits: buf.readUInt16LE(14),
        };
        if (tagRaw === 0xfffe && buf.length >= 40) fmt.tag = buf.readUInt16LE(24);
      } else if (id === 'ds64') {
        const buf = await r.readExact(Math.min(size, 28));
        dataSize64 = readU64LE(buf, 8);
      } else if (id === 'data') {
        if (rf64 && size === 0xffffffff && dataSize64 >= 0) size = dataSize64;
        this.dataStart = body;
        const avail = r.size - body;
        if (size === 0 || size > avail) size = avail;
        this.dataEnd = body + size;
        found = true;
        if (!fmt) {
          r.seek(this.dataEnd + (size & 1));
          continue;
        }
        const next = this.dataEnd + (size & 1);
        if (next + 8 <= r.size) {
          r.seek(next);
          continue;
        }
        break;
      } else if (id === 'LIST') {
        if (size >= 4 && size < 1 << 20) {
          const buf = await r.readExact(size);
          if (buf.toString('latin1', 0, 4) === 'INFO') Object.assign(this.tags, parseRiffInfo(buf.subarray(4)));
        }
      }
      r.seek(body + size + (size & 1));
    }
    if (!fmt) throw badData('wav: missing fmt chunk');
    if (!found) throw badData('wav: missing data chunk');
    if (fmt.channels < 1 || fmt.sampleRate < 1) throw badData('wav: invalid format');
    const codec = codecFromTag(fmt.tag, fmt.bits);
    const info = formats[codec];
    this.blockAlign = fmt.blockAlign || fmt.channels * Math.ceil(fmt.bits / 8);
    if (info && this.blockAlign !== fmt.channels * info.bytes) this.blockAlign = fmt.channels * info.bytes;
    const frames = Math.floor((this.dataEnd - this.dataStart) / this.blockAlign);
    this.dataEnd = this.dataStart + frames * this.blockAlign;
    this.cursor = this.dataStart;
    this.streams.push({
      index: 0,
      type: 'audio',
      codec,
      timeScale: fmt.sampleRate,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: info ? info.bits : fmt.bits,
      bitRate: fmt.sampleRate * this.blockAlign * 8,
      duration: frames / fmt.sampleRate,
      frames,
      extradata: null,
    });
    this.duration = frames / fmt.sampleRate;
  }

  async seek(seconds) {
    const rate = this.streams[0].sampleRate;
    const frame = Math.max(0, Math.min(Math.floor(seconds * rate), (this.dataEnd - this.dataStart) / this.blockAlign));
    this.cursor = this.dataStart + frame * this.blockAlign;
    return frame / rate;
  }

  async readPacket() {
    if (this.cursor >= this.dataEnd) return null;
    const want = Math.min(4096 * this.blockAlign, this.dataEnd - this.cursor);
    this.reader.seek(this.cursor);
    const data = await this.reader.read(want);
    if (data.length === 0) return null;
    const usable = data.length - (data.length % this.blockAlign);
    if (usable === 0) return null;
    const frame = (this.cursor - this.dataStart) / this.blockAlign;
    this.cursor += usable;
    return {
      stream: 0,
      pts: frame,
      dts: frame,
      duration: usable / this.blockAlign,
      key: true,
      data: usable === data.length ? data : data.subarray(0, usable),
    };
  }

  async close() {
    await this.reader.close();
  }
}

export {
  WavDemuxer,
};
