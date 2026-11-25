import { noSupport } from '../errors.js';

function opusPacketDuration(data) {
  if (data.length < 1) return 0;
  const toc = data[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = [480, 960][config & 1];
  else frame = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  let count = 1;
  if (code === 3) count = data.length > 1 ? data[1] & 0x3f : 1;
  else if (code !== 0) count = 2;
  return frame * count;
}

function parseOpusHead(buf) {
  if (buf.length < 19 || buf.toString('latin1', 0, 8) !== 'OpusHead') return null;
  return {
    version: buf[8],
    channels: buf[9],
    preSkip: buf.readUInt16LE(10),
    inputRate: buf.readUInt32LE(12),
    gain: buf.readInt16LE(16),
    family: buf[18],
  };
}

function buildOpusHead(info, mapping) {
  const extra = info.family ? mapping || Buffer.alloc(0) : Buffer.alloc(0);
  const out = Buffer.alloc(19 + extra.length);
  out.write('OpusHead', 0, 'latin1');
  out[8] = 1;
  out[9] = info.channels;
  out.writeUInt16LE(info.preSkip, 10);
  out.writeUInt32LE(info.inputRate, 12);
  out.writeInt16LE(info.gain || 0, 16);
  out[18] = info.family || 0;
  extra.copy(out, 19);
  return out;
}

const loadBackend = () => import('./libopus.js');

class OpusPacketDecoder {
  constructor(native, stream) {
    this.native = native;
    this.channels = stream.channels;
    this.preSkip = stream.preSkip || 0;
  }

  decode(data, pkt) {
    const pcm = this.native.decodeFloat(data);
    const decoded = pcm.length / this.channels;
    const keep = Math.min(decoded, pkt.duration ?? decoded);
    const origin = pkt.pts0 ?? pkt.pts;
    const skip = Math.min(Math.max(0, this.preSkip - origin), keep);
    const base = pkt.pts - origin;
    return { data: pcm.subarray(skip * this.channels, keep * this.channels), frames: keep - skip, pts: base + origin + skip - this.preSkip };
  }

  dispose() {
    this.native.free();
  }
}

class OpusPacketEncoder {
  constructor(native, channels) {
    this.native = native;
    this.channels = channels;
    this.frameSize = native.frameSize;
    this.preSkip = Math.round(native.getLookahead() * 48000 / native.sampleRate);
    this.buffer = new Float32Array(this.frameSize * channels);
    this.buffered = 0;
    this.fed = 0;
    this.position = 0;
    const head = buildOpusHead({ channels, preSkip: this.preSkip, inputRate: native.sampleRate, gain: 0, family: 0 });
    this.stream = { type: 'audio', codec: 'opus', timeScale: 48000, sampleRate: 48000, channels, extradata: head, headers: [head] };
  }

  encode(data, frames) {
    const packets = [];
    const size = this.buffer.length;
    const total = frames * this.channels;
    this.fed += frames;
    for (let i = 0; i < total;) {
      const take = Math.min(size - this.buffered, total - i);
      this.buffer.set(data.subarray(i, i + take), this.buffered);
      this.buffered += take;
      i += take;
      if (this.buffered === size) {
        packets.push(this.emit(960));
        this.buffered = 0;
      }
    }
    return packets;
  }

  flush() {
    const end = Math.round(this.fed * 48000 / this.native.sampleRate) + this.preSkip;
    const packets = [];
    while (this.position < end) {
      this.buffer.fill(0, this.buffered);
      this.buffered = 0;
      packets.push(this.emit(Math.min(960, end - this.position)));
    }
    return packets;
  }

  emit(duration) {
    const packet = { pts: this.position, dts: this.position, duration, key: true, data: Buffer.from(this.native.encodeFloat(this.buffer)) };
    this.position += duration;
    return packet;
  }

  dispose() {
    this.native.free();
  }
}

async function createOpusDecoder(stream) {
  if (stream.channels > 2) throw noSupport('opus decoding supports 1 or 2 channels');
  const { createDecoder } = await loadBackend();
  return new OpusPacketDecoder(await createDecoder({ sampleRate: 48000, channels: stream.channels }), stream);
}

async function createOpusEncoder(params) {
  const { createEncoder } = await loadBackend();
  const native = await createEncoder({ sampleRate: params.sampleRate, channels: params.channels, bitrate: params.bitrate || 64000, frameSize: params.sampleRate / 50 });
  return new OpusPacketEncoder(native, params.channels);
}

export {
  opusPacketDuration,
  parseOpusHead,
  buildOpusHead,
  createOpusDecoder,
  createOpusEncoder,
};
