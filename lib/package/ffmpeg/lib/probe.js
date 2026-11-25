import { openDemuxer } from './demux/index.js';
import { wrap } from './errors.js';

function publicStream(s) {
  const out = { index: s.index, type: s.type, codec: s.codec };
  const keys = ['sampleRate', 'channels', 'bitsPerSample', 'bitRate', 'duration', 'width', 'height', 'frameRate', 'timeScale'];
  for (const k of keys) if (s[k] !== undefined && s[k] !== null && !Number.isNaN(s[k])) out[k] = s[k];
  return out;
}

function brandName(demuxer) {
  if (demuxer.format !== 'mp4') return demuxer.format;
  const b = (demuxer.brand || '').trim();
  if (b === 'qt') return 'mov';
  if (b === 'M4A') return 'm4a';
  return 'mp4';
}

async function probe(input) {
  const demuxer = await openDemuxer(input);
  try {
    if (typeof demuxer.scanDuration === 'function') await demuxer.scanDuration();
    const duration = demuxer.duration;
    const size = demuxer.size;
    return {
      format: {
        name: brandName(demuxer),
        size,
        duration,
        bitRate: duration > 0 ? Math.round((size * 8) / duration) : undefined,
        tags: Object.assign({}, demuxer.tags),
      },
      streams: demuxer.streams.map(publicStream),
    };
  } catch (e) {
    throw wrap(e);
  } finally {
    await demuxer.close();
  }
}

export {
  probe,
  brandName,
};
