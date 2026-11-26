import fs from 'node:fs';
import pathMod from 'node:path';
import { badArg, noSupport, wrap } from './errors.js';
import { debug, isDebug } from './debug.js';
import { FileSink, BufferSink } from './io.js';
import { openDemuxer } from './demux/index.js';
import { WavMuxer } from './mux/wav.js';
import { FlacMuxer } from './mux/flac.js';
import { Mp3Muxer } from './mux/mp3.js';
import { AdtsMuxer } from './mux/adts.js';
import { OggMuxer } from './mux/ogg.js';
import { Mp4Muxer } from './mux/mp4.js';
import { canDecode, canEncode, createDecoderAsync, createEncoderAsync, prerollFrames } from './codec/index.js';
import { formats, isPcm, pcmCodecForBits } from './codec/pcm.js';
import { Resampler } from './filter/resample.js';
import { ChannelMixer } from './filter/mix.js';
import { Trim, Gain } from './filter/gain.js';
import { parseTime, parseGain, equalBuffers } from './util.js';
import * as tags from './tags.js';
import { runImage } from './image/run.js';
import { MergedDemuxer } from './demux/merge.js';
import { resolveInput, Temps } from './net.js';
import { videoCopyEquivalent, audioCopyEquivalent } from './compat.js';
import { outputFormatOf } from './image/index.js';


const formatNames = {
  wav: ['wav', 'wav'],
  wave: ['wav', 'wav'],
  flac: ['flac', 'flac'],
  mp3: ['mp3', 'mp3'],
  aac: ['adts', 'adts'],
  adts: ['adts', 'adts'],
  ogg: ['ogg', 'ogg'],
  oga: ['ogg', 'ogg'],
  opus: ['ogg', 'ogg'],
  mp4: ['mp4', 'mp4'],
  m4v: ['mp4', 'mp4'],
  m4a: ['mp4', 'm4a'],
  mov: ['mp4', 'mov'],
};


function resolveFormat(opts) {
  let key = opts.format ? String(opts.format).toLowerCase() : null;
  if (!key && typeof opts.output === 'string') key = pathMod.extname(opts.output).slice(1).toLowerCase();
  if (!key || !formatNames[key]) throw badArg('cannot determine output format' + (key ? ': ' + key : ''));
  const [name, brand] = formatNames[key];
  return { name, brand, Muxer: { wav: WavMuxer, flac: FlacMuxer, mp3: Mp3Muxer, adts: AdtsMuxer, ogg: OggMuxer, mp4: Mp4Muxer }[name] };
}

function numberOpt(value, name, min) {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min) throw badArg('invalid option: ' + name);
  return n;
}

function normalize(options) {
  if (!options || typeof options !== 'object') throw badArg('options object required');
  const o = options;
  let inputs = o.inputs !== undefined ? o.inputs : o.input;
  if (inputs === undefined || inputs === null) throw badArg('input required');
  if (!Array.isArray(inputs)) inputs = [inputs];
  if (!inputs.length) throw badArg('input required');
  const start = parseTime(o.start !== undefined ? o.start : o.ss);
  const endRaw = parseTime(o.end !== undefined ? o.end : o.to);
  const dur = parseTime(o.duration !== undefined ? o.duration : o.t);
  if ((start !== undefined && !(start >= 0)) || (endRaw !== undefined && !(endRaw >= 0)) || (dur !== undefined && !(dur >= 0))) throw badArg('invalid time option');
  const startSec = start || 0;
  let endSec = Infinity;
  if (endRaw !== undefined) endSec = endRaw;
  if (dur !== undefined) endSec = Math.min(endSec, startSec + dur);
  if (endSec <= startSec && Number.isFinite(endSec)) throw badArg('end must be greater than start');
  const volume = parseGain(o.volume);
  if (!Number.isFinite(volume) || volume < 0) throw badArg('invalid volume');
  const out = {
    inputs,
    output: o.output,
    format: o.format || (o.output && typeof o.output === 'object' ? o.output.format : undefined),
    codec: o.codec || o.audioCodec,
    videoCodec: o.videoCodec,
    startSec,
    endSec,
    sampleRate: numberOpt(o.sampleRate !== undefined ? o.sampleRate : o.ar, 'sampleRate', 1),
    channels: numberOpt(o.channels !== undefined ? o.channels : o.ac, 'channels', 1),
    bitDepth: numberOpt(o.bitDepth, 'bitDepth', 4),
    bitrate: numberOpt(o.bitrate, 'bitrate', 1),
    volume,
    fadeIn: numberOpt(o.fadeIn, 'fadeIn', 0) || 0,
    fadeOut: numberOpt(o.fadeOut, 'fadeOut', 0) || 0,
    noAudio: Boolean(o.noAudio || o.an),
    noVideo: Boolean(o.noVideo || o.vn),
    metadata: tags.clean(o.metadata),
    stripMetadata: Boolean(o.stripMetadata),
    faststart: Boolean(o.faststart),
    overwrite: o.overwrite === undefined ? true : Boolean(o.overwrite),
    streams: Array.isArray(o.streams) ? o.streams : null,
    videoFilter: o.videoFilter !== undefined ? o.videoFilter : o.vf,
    frames: numberOpt(o.frames !== undefined ? o.frames : o.vframes, 'frames', 1),
    qscale: numberOpt(o.qscale, 'qscale', 0),
    quality: numberOpt(o.quality, 'quality', 1),
    compressionLevel: numberOpt(o.compressionLevel, 'compressionLevel', 0),
    pixFmt: o.pixFmt,
    merge: Boolean(o.merge),
    maps: Array.isArray(o.maps) ? o.maps : [],
    shortest: Boolean(o.shortest),
    net: o.net && typeof o.net === 'object' ? o.net : {},
    smartCopy: Boolean(o.smartCopy),
    compat: Boolean(o.compat),
    maxPixels: numberOpt(o.maxPixels, 'maxPixels', 1),
  };
  if (out.quality !== undefined && out.quality > 100) throw badArg('quality must be from 1 to 100');
  if (out.qscale !== undefined && out.qscale > 31) throw badArg('qscale must be from 0 to 31');
  if (out.channels !== undefined && (out.channels > 8 || !Number.isInteger(out.channels))) throw badArg('channels must be an integer from 1 to 8');
  if (out.sampleRate !== undefined && !Number.isInteger(out.sampleRate)) throw badArg('sampleRate must be an integer');
  if (o.output !== undefined && o.output !== null && typeof o.output !== 'string' && typeof o.output !== 'object') throw badArg('invalid output');
  return out;
}

class InputSet {
  constructor(demuxers) {
    this.demuxers = demuxers;
    this.streams = demuxers[0].streams;
    this.cur = 0;
    this.maps = demuxers.map((d, k) => {
      const map = new Map();
      if (k === 0) {
        for (const s of d.streams) map.set(s.index, s);
        return map;
      }
      for (const type of ['audio', 'video']) {
        const a = this.streams.find((s) => s.type === type);
        const b = d.streams.find((s) => s.type === type);
        if (a && b) map.set(b.index, { first: a, stream: b });
      }
      return map;
    });
    this.lastEnd = new Map();
    this.offset = new Map();
  }

  streamOf(seg, index) {
    const m = this.maps[seg].get(index);
    if (!m) return null;
    return seg === 0 ? m : m.stream;
  }

  matchFor(seg, firstStream) {
    for (const m of this.maps[seg].values()) if (m.first === firstStream) return m.stream;
    return null;
  }

  async readPacket() {
    for (;;) {
      const d = this.demuxers[this.cur];
      const pkt = await d.readPacket();
      if (!pkt) {
        if (++this.cur >= this.demuxers.length) return null;
        for (const [idx, end] of this.lastEnd) this.offset.set(idx, end);
        continue;
      }
      let target = pkt.stream;
      pkt.pts0 = pkt.pts;
      if (this.cur > 0) {
        const m = this.maps[this.cur].get(pkt.stream);
        if (!m) continue;
        target = m.first.index;
        const off = this.offset.get(target) || 0;
        pkt.pts += off;
        pkt.dts += off;
        pkt.stream = target;
      }
      const end = pkt.pts + (pkt.duration || 0);
      if (end > (this.lastEnd.get(target) || 0)) this.lastEnd.set(target, end);
      pkt.seg = this.cur;
      return pkt;
    }
  }
}

function hasFilters(o) {
  return o.sampleRate !== undefined || o.channels !== undefined || o.volume !== 1 || o.fadeIn > 0 || o.fadeOut > 0;
}

function defaultBits(stream, opts) {
  if (opts.bitDepth) return opts.bitDepth;
  const codec = stream.codec;
  if (codec === 'flac') return Math.min(24, stream.bitsPerSample || 16);
  if (isPcm(codec)) {
    const info = formats[codec];
    if (info.float) return 24;
    if (codec === 'pcm_alaw' || codec === 'pcm_mulaw') return 16;
    return Math.min(24, info.bits);
  }
  return 16;
}

function targetCodec(stream, opts, fmt) {
  if (opts.codec && opts.codec !== 'copy') return opts.codec === 'libopus' ? 'opus' : opts.codec;
  if (fmt.name === 'wav') return isPcm(stream.codec) ? stream.codec : pcmCodecForBits(defaultBits(stream, opts), false);
  if (fmt.name === 'flac') return 'flac';
  if (fmt.name === 'ogg') return 'opus';
  return null;
}

function streamsCompatible(a, b) {
  if (a.type !== b.type || a.codec !== b.codec) return false;
  if (a.type === 'audio') return a.channels === b.channels && a.sampleRate === b.sampleRate && equalBuffers(a.extradata, b.extradata);
  return a.width === b.width && a.height === b.height && equalBuffers(a.extradata, b.extradata);
}

class Chain {
  static async create(stream, outRate, outCh) {
    return new Chain(await createDecoderAsync(stream), stream, outRate, outCh);
  }

  constructor(decoder, stream, outRate, outCh) {
    this.decoder = decoder;
    this.mixer = stream.channels !== outCh ? new ChannelMixer(stream.channels, outCh) : null;
    this.resampler = stream.sampleRate !== outRate ? new Resampler(stream.sampleRate, outRate, outCh) : null;
  }

  push(pkt) {
    const dec = this.decoder.decode(pkt.data, pkt);
    const pts = dec.pts !== undefined ? dec.pts : pkt.pts;
    if (dec.frames === 0) return { data: dec.data, frames: 0, pts };
    let cur = dec;
    if (this.mixer) cur = this.mixer.process(cur.data, cur.frames);
    if (this.resampler) cur = this.resampler.process(cur.data, cur.frames);
    return { data: cur.data, frames: cur.frames, pts };
  }

  flush() {
    return this.resampler ? this.resampler.flush() : null;
  }

  dispose() {
    this.decoder.dispose?.();
  }
}

class AudioTranscode {
  static async create(cfg) {
    return new AudioTranscode(cfg, await createEncoderAsync(cfg.codec, { sampleRate: cfg.outRate, channels: cfg.outCh, bitsPerSample: cfg.bits, bitrate: cfg.bitrate }));
  }

  constructor(cfg, encoder) {
    this.cfg = cfg;
    this.encoder = encoder;
    this.descriptor = this.encoder.stream;
    this.trim = null;
    this.gain = new Gain({ volume: cfg.volume, fadeInFrames: Math.round(cfg.fadeIn * cfg.outRate), fadeOutFrames: Math.round(cfg.fadeOut * cfg.outRate), totalFrames: cfg.totalFrames }, cfg.outCh);
    this.chain = null;
    this.seg = -1;
    this.started = false;
    this.written = 0;
  }

  get done() {
    return Boolean(this.trim && this.trim.done);
  }

  async emit(cur) {
    if (!cur || cur.frames === 0) return;
    const r = this.trim.process(cur.data, cur.frames, this.cfg.outCh);
    if (!r) return;
    this.gain.process(r.data, r.frames);
    await this.cfg.write(this.encoder.encode(r.data, r.frames));
  }

  async push(pkt, stream, seg) {
    if (this.done) return;
    const cfg = this.cfg;
    if (!this.started && cfg.canSkip) {
      const pre = prerollFrames(stream.codec) * (pkt.duration || 0);
      if (pkt.pts + pkt.duration <= cfg.startSec * stream.timeScale - pre - 1e-6) return;
    }
    if (seg !== this.seg) {
      await this.endChain();
      this.chain = await Chain.create(stream, cfg.outRate, cfg.outCh);
      this.seg = seg;
    }
    const cur = this.chain.push(pkt);
    if (!this.started) {
      if (cur.frames === 0) return;
      const t0 = cur.pts / stream.timeScale;
      const skip = Math.round(Math.max(0, cfg.startSec - Math.max(0, t0)) * cfg.outRate);
      const limit = Number.isFinite(cfg.endSec) ? Math.round((cfg.endSec - cfg.startSec) * cfg.outRate) : undefined;
      this.trim = new Trim(skip, limit);
      this.started = true;
    }
    await this.emit(cur);
  }

  async endChain() {
    if (!this.chain) return;
    const tail = this.chain.flush();
    this.chain.dispose();
    this.chain = null;
    if (this.started) await this.emit(tail);
  }

  async finish() {
    await this.endChain();
    await this.cfg.write(this.encoder.flush());
    this.encoder.dispose?.();
  }
}

async function maybeYield(state) {
  const now = Date.now();
  if (now - state.last >= 20) {
    await new Promise((resolve) => setImmediate(resolve));
    state.last = Date.now();
  }
}

function imageFormatFor(opts) {
  let key = opts.format ? String(opts.format).toLowerCase() : null;
  if (!key && typeof opts.output === 'string') key = pathMod.extname(opts.output).slice(1).toLowerCase();
  if (key === 'image2' || key === 'image2pipe') key = typeof opts.output === 'string' ? pathMod.extname(opts.output).slice(1).toLowerCase() : null;
  return outputFormatOf(key);
}

async function run(options) {
  const opts = normalize(options);
  const imageFormat = imageFormatFor(opts);
  if (imageFormat) {
    try {
      return await runImage(opts, imageFormat);
    } catch (e) {
      throw wrap(e);
    }
  }
  const fmt = resolveFormat(opts);
  const toFile = typeof opts.output === 'string';
  const demuxers = [];
  const temps = new Temps();
  let sink = null;
  let created = false;
  try {
    if (toFile) {
      const abs = pathMod.resolve(opts.output);
      for (const src of opts.inputs) {
        if (typeof src === 'string' && pathMod.resolve(src) === abs) throw badArg('output must differ from input');
      }
      if (!opts.overwrite && fs.existsSync(abs)) throw badArg('output exists: ' + opts.output);
    }
    const groups = [];
    for (const src of opts.inputs) groups.push(await resolveInput(src, opts.net, temps));
    const flat = groups.flat();
    if (!opts.merge && opts.inputs.length > 1 && flat.length !== opts.inputs.length) throw noSupport('inputs expanded into multiple streams cannot be concatenated');
    const opened = [];
    for (const src of flat) opened.push(await openDemuxer(src));
    if (opts.merge || opts.maps.length || flat.length !== opts.inputs.length) demuxers.push(new MergedDemuxer(opened, opts.maps, { shortest: opts.shortest }));
    else demuxers.push(...opened);
    const set = new InputSet(demuxers);
    const first = demuxers[0];
    const single = demuxers.length === 1;
    let selected;
    if (opts.streams) {
      selected = opts.streams.map((i) => first.streams.find((s) => s.index === i)).filter(Boolean);
    } else {
      selected = [];
      const video = first.streams.find((s) => s.type === 'video');
      const audio = first.streams.find((s) => s.type === 'audio');
      if (!opts.noVideo && video && fmt.Muxer === Mp4Muxer) selected.push(video);
      if (!opts.noAudio && audio) selected.push(audio);
      selected.sort((a, b) => a.index - b.index);
    }
    if (!selected.length) throw badArg('no streams to process');

    const plans = selected.map((s) => planStream(s, opts, fmt, single));
    plans.forEach((p, i) => {
      p.outIndex = i;
    });
    for (let k = 1; k < demuxers.length; k++) {
      for (let i = 0; i < plans.length; i++) {
        const match = set.matchFor(k, plans[i].stream);
        if (!match) throw badArg('input ' + k + ' lacks a matching ' + plans[i].stream.type + ' stream');
        if (plans[i].mode === 'copy' && !streamsCompatible(plans[i].stream, match)) {
          if (opts.codec === 'copy' || plans[i].stream.type === 'video') throw badArg('inputs have incompatible ' + plans[i].stream.type + ' streams for stream copy');
          const outIndex = plans[i].outIndex;
          plans[i] = planStream(plans[i].stream, opts, fmt, single, true);
          plans[i].outIndex = outIndex;
        }
        if (plans[i].mode === 'transcode' && !canDecode(match.codec)) throw noSupport('no decoder available for codec ' + match.codec);
      }
    }

    let totalDuration;
    if (demuxers.every((d) => d.duration > 0)) totalDuration = demuxers.reduce((n, d) => n + d.duration, 0);
    for (const p of plans) {
      if (p.mode !== 'transcode') continue;
      const rate = p.cfg.outRate;
      const end = Math.min(opts.endSec, totalDuration === undefined ? Infinity : totalDuration);
      if (Number.isFinite(end)) p.cfg.totalFrames = Math.max(0, Math.round((end - opts.startSec) * rate));
      if (opts.fadeOut > 0 && !p.cfg.totalFrames) throw badArg('fadeOut requires a known duration');
    }

    const outTags = opts.stripMetadata ? {} : Object.assign({}, first.tags);
    Object.assign(outTags, opts.metadata);

    const state = { last: Date.now() };
    const outStreams = [];
    for (const p of plans) {
      if (p.mode === 'copy') {
        const d = Object.assign({}, p.stream, { index: p.outIndex });
        if (opts.startSec > 0) {
          d.encoderDelay = 0;
          d.encoderPadding = 0;
        }
        outStreams.push(d);
        p.rate = p.stream.timeScale;
      } else {
        p.audio = await AudioTranscode.create(Object.assign({}, p.cfg, { startSec: opts.startSec, endSec: opts.endSec, canSkip: single }));
        const d = Object.assign({}, p.audio.descriptor, { index: p.outIndex });
        if (!fmt.Muxer.accepts(d)) throw noSupport('output format ' + fmt.name + ' cannot hold codec ' + d.codec);
        outStreams.push(d);
        p.rate = d.timeScale;
      }
      p.maxEnd = 0;
    }

    if (toFile) {
      sink = await FileSink.open(pathMod.resolve(opts.output));
      created = true;
    } else sink = new BufferSink();
    const muxer = new fmt.Muxer(sink, { tags: outTags, faststart: opts.faststart, brand: fmt.brand });
    await muxer.open(outStreams);

    const byInput = new Map(plans.map((p) => [p.stream.index, p]));
    for (const p of plans) {
      if (p.mode === 'transcode') {
        p.audio.cfg.write = async (packets) => {
          for (const pk of packets) {
            const end = (pk.pts + pk.duration) / p.rate;
            if (end > p.maxEnd) p.maxEnd = end;
            await muxer.writePacket(p.outIndex, pk);
          }
        };
      }
    }

    let origin = opts.startSec === 0 ? 0 : undefined;
    let seeked = false;
    if (single && opts.startSec > 0 && typeof first.seek === 'function') {
      origin = await first.seek(opts.startSec);
      seeked = true;
      debug('pipeline', 'seek', { requested: opts.startSec, origin });
    }
    if (isDebug()) debug('pipeline', 'plan', plans.map((p) => ({ stream: p.stream.index, mode: p.mode, codec: p.stream.codec })));

    for (;;) {
      const pkt = await set.readPacket();
      if (!pkt) break;
      const p = byInput.get(pkt.stream);
      if (!p) continue;
      if (p.mode === 'copy') {
        if (p.done) continue;
        const ts = p.stream.timeScale;
        const ptsSec = pkt.pts / ts;
        if (opts.startSec > 0) {
          if (seeked) {
            if (ptsSec < origin - 1e-6) continue;
          } else if (ptsSec < opts.startSec - 1e-6) continue;
          else if (origin === undefined) origin = ptsSec;
        }
        if (ptsSec >= opts.endSec - 1e-9) {
          p.done = true;
          if (plans.every((x) => (x.mode === 'copy' ? x.done : x.audio.done))) break;
          continue;
        }
        if (origin) {
          const shift = Math.round(origin * ts);
          pkt.pts -= shift;
          pkt.dts -= shift;
        }
        const end = (pkt.pts + pkt.duration) / ts;
        if (end > p.maxEnd) p.maxEnd = end;
        await muxer.writePacket(p.outIndex, pkt);
      } else {
        if (p.audio.done) {
          if (plans.every((x) => (x.mode === 'copy' ? x.done : x.audio.done))) break;
          continue;
        }
        const stream = set.streamOf(pkt.seg, pkt.stream);
        await p.audio.push(pkt, stream, pkt.seg);
      }
      await maybeYield(state);
    }
    for (const p of plans) if (p.mode === 'transcode') await p.audio.finish();
    await muxer.finish();
    await sink.flush();
    const size = sink.length;
    const duration = Math.max(0, ...plans.map((p) => p.maxEnd));
    const result = { format: fmt.brand === 'mp4' ? fmt.name : fmt.brand, size, duration, streams: outStreams.map((s) => ({ index: s.index, type: s.type, codec: s.codec })) };
    if (toFile) {
      await sink.close();
      sink = null;
      result.output = opts.output;
    } else {
      result.output = Buffer.from(sink.result());
      await sink.close();
      sink = null;
    }
    return result;
  } catch (e) {
    if (sink) {
      try {
        await sink.close();
      } catch (ignored) {
        sink = null;
      }
    }
    if (created) {
      try {
        await fs.promises.unlink(pathMod.resolve(opts.output));
      } catch (ignored) {
        created = false;
      }
    }
    throw wrap(e);
  } finally {
    for (const d of demuxers) {
      try {
        await d.close();
      } catch (ignored) {
        d.closed = true;
      }
    }
    await temps.cleanup();
  }
}

function planStream(s, opts, fmt, single, forceTranscode) {
  const Muxer = fmt.Muxer;
  if (s.type === 'video') {
    if (opts.videoCodec && opts.videoCodec !== 'copy' && !videoCopyEquivalent(s, opts)) throw noSupport('video transcoding is not supported; use stream copy');
    if (!Muxer.accepts(s)) throw noSupport('output format ' + fmt.name + ' cannot hold video codec ' + s.codec);
    return { mode: 'copy', stream: s, done: false };
  }
  const filters = hasFilters(opts);
  const explicit = opts.codec && opts.codec !== 'copy';
  const trimmed = opts.startSec > 0 || Number.isFinite(opts.endSec);
  if (opts.codec === 'copy') {
    if (filters) throw badArg('filters cannot be combined with stream copy');
    if (!Muxer.accepts(s)) throw noSupport('output format ' + fmt.name + ' cannot hold codec ' + s.codec);
    return { mode: 'copy', stream: s, done: false };
  }
  if (explicit && audioCopyEquivalent(s, opts) && Muxer.accepts(s) && !trimmed) return { mode: 'copy', stream: s, done: false };
  const sampleAccurate = isPcm(s.codec) && trimmed;
  if (!forceTranscode && !explicit && !filters && !sampleAccurate && Muxer.accepts(s)) return { mode: 'copy', stream: s, done: false };
  const target = targetCodec(s, opts, fmt);
  if (!target) throw noSupport('cannot convert ' + s.codec + ' to ' + fmt.name + ': no encoder available');
  if (!canDecode(s.codec)) throw noSupport('no decoder available for codec ' + s.codec);
  if (!canEncode(target)) throw noSupport('no encoder available for codec ' + target);
  const outRate = opts.sampleRate || (target === 'opus' ? 48000 : s.sampleRate);
  const outCh = opts.channels || s.channels;
  if (target === 'opus' && (![8000, 12000, 16000, 24000, 48000].includes(outRate) || outCh > 2)) throw badArg('opus output needs a sample rate of 8000, 12000, 16000, 24000 or 48000 Hz and 1 or 2 channels');
  return {
    mode: 'transcode',
    stream: s,
    cfg: {
      codec: target,
      outRate,
      outCh,
      bits: defaultBits(s, opts),
      bitrate: opts.bitrate,
      volume: opts.volume,
      fadeIn: opts.fadeIn,
      fadeOut: opts.fadeOut,
      totalFrames: 0,
    },
  };
}

export {
  run,
};
