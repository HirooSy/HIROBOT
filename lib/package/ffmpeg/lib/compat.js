import { parseFilters, outputSize } from './filter/video.js';
import { parseAvcc, parseSps } from './bsf.js';

function h264Facts(stream) {
  if (stream.h264) return stream.h264;
  if (stream.codec !== 'h264' || !stream.extradata) return null;
  try {
    const avc = parseAvcc(stream.extradata);
    if (!avc.sps.length) return null;
    stream.h264 = parseSps(avc.sps[0]);
    return stream.h264;
  } catch (ignored) {
    return null;
  }
}

function videoCopyEquivalent(stream, opts) {
  if (!opts.smartCopy) return false;
  const codec = String(opts.videoCodec || '').toLowerCase();
  if (!['libx264', 'h264', 'x264', 'h264_nvenc', 'h264_qsv'].includes(codec)) return false;
  if (stream.codec !== 'h264' || !stream.mp4Entry) return false;
  const facts = h264Facts(stream);
  if (!facts || facts.chroma !== 1 || facts.bitDepth !== 8 || !facts.frameMbsOnly) return false;
  if (facts.width % 2 || facts.height % 2) return false;
  if (opts.pixFmt && !/^yuvj?420p$/i.test(String(opts.pixFmt))) return false;
  if (opts.frames !== undefined) return false;
  let size;
  try {
    size = outputSize(parseFilters(opts.videoFilter), facts.width, facts.height);
  } catch (ignored) {
    return false;
  }
  return Boolean(size) && size.width === facts.width && size.height === facts.height;
}

function audioCopyEquivalent(stream, opts) {
  if (!opts.smartCopy) return false;
  const codec = String(opts.codec || '').toLowerCase();
  return codec === stream.codec && stream.type === 'audio' && opts.sampleRate === undefined && opts.channels === undefined && opts.volume === 1 && !(opts.fadeIn > 0) && !(opts.fadeOut > 0) && !(opts.bitrate > 0);
}

export { videoCopyEquivalent, audioCopyEquivalent, h264Facts };
