import { noSupport } from '../errors.js';
import { formats, isPcm, PcmDecoder, PcmEncoder } from './pcm.js';
import { FlacDecoder, FlacEncoder } from './flac.js';
import { Mp3Decoder } from './mp3.js';
import { createOpusDecoder, createOpusEncoder } from './opus.js';

function canDecode(codec) {
  return isPcm(codec) || codec === 'flac' || codec === 'mp3' || codec === 'opus';
}

function prerollFrames(codec) {
  return codec === 'mp3' ? Mp3Decoder.preroll : codec === 'opus' ? 1 : 0;
}

function canEncode(codec) {
  return isPcm(codec) || codec === 'flac' || codec === 'opus';
}

function createDecoder(stream) {
  if (isPcm(stream.codec)) return new PcmDecoder(stream);
  if (stream.codec === 'flac') return new FlacDecoder(stream);
  if (stream.codec === 'mp3') return new Mp3Decoder(stream);
  throw noSupport('no decoder available for codec ' + stream.codec);
}

class PcmPacketEncoder {
  constructor(codec, params) {
    this.codec = codec;
    this.channels = params.channels;
    this.inner = new PcmEncoder(codec, params.channels);
    this.position = 0;
    this.stream = {
      type: 'audio',
      codec,
      timeScale: params.sampleRate,
      sampleRate: params.sampleRate,
      channels: params.channels,
      bitsPerSample: formats[codec].bits,
      extradata: null,
    };
  }

  encode(data, frames) {
    if (frames <= 0) return [];
    const buf = this.inner.encode(data, frames);
    const pts = this.position;
    this.position += frames;
    return [{ pts, dts: pts, duration: frames, key: true, data: buf }];
  }

  flush() {
    return [];
  }
}

class FlacPacketEncoder {
  constructor(params) {
    this.inner = new FlacEncoder({
      sampleRate: params.sampleRate,
      channels: params.channels,
      bitsPerSample: params.bitsPerSample,
      blockSize: params.blockSize,
    });
    this.stream = {
      type: 'audio',
      codec: 'flac',
      timeScale: params.sampleRate,
      sampleRate: params.sampleRate,
      channels: params.channels,
      bitsPerSample: params.bitsPerSample,
      extradata: this.inner.extradata,
    };
  }

  encode(data, frames) {
    return this.inner.push(data, frames);
  }

  flush() {
    return this.inner.flush();
  }
}

function createEncoder(codec, params) {
  if (isPcm(codec)) return new PcmPacketEncoder(codec, params);
  if (codec === 'flac') return new FlacPacketEncoder(params);
  throw noSupport('no encoder available for codec ' + codec);
}

async function createDecoderAsync(stream) {
  if (stream.codec === 'opus') return createOpusDecoder(stream);
  return createDecoder(stream);
}

async function createEncoderAsync(codec, params) {
  if (codec === 'opus') return createOpusEncoder(params);
  return createEncoder(codec, params);
}

export {
  canDecode,
  canEncode,
  createDecoder,
  createEncoder,
  createDecoderAsync,
  createEncoderAsync,
  prerollFrames,
};
