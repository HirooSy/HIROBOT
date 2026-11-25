import { openReader } from '../io.js';
import { badData, wrap } from '../errors.js';
import { debug } from '../debug.js';
import { id3Size } from '../tags.js';
import { WavDemuxer } from './wav.js';
import { FlacDemuxer } from './flac.js';
import { Mp3Demuxer } from './mp3.js';
import { AdtsDemuxer } from './adts.js';
import { OggDemuxer } from './ogg.js';
import { Mp4Demuxer } from './mp4.js';

async function candidates(reader) {
  const head = await reader.peek(16);
  if (WavDemuxer.probe(head)) return [WavDemuxer];
  if (FlacDemuxer.probe(head)) return [FlacDemuxer];
  if (OggDemuxer.probe(head)) return [OggDemuxer];
  if (Mp4Demuxer.probe(head)) return [Mp4Demuxer];
  let audioHead = head;
  const skip = id3Size(head);
  if (skip > 0) {
    reader.seek(skip);
    audioHead = await reader.peek(16);
    reader.seek(0);
    if (audioHead.toString('latin1', 0, 4) === 'fLaC') return [FlacDemuxer];
  }
  if (AdtsDemuxer.probe(audioHead)) return [AdtsDemuxer, Mp3Demuxer];
  return [Mp3Demuxer, AdtsDemuxer];
}

async function openDemuxer(input, windowSize) {
  const reader = await openReader(input, windowSize);
  try {
    const list = await candidates(reader);
    let last = null;
    for (const Demuxer of list) {
      reader.seek(0);
      try {
        const demuxer = await Demuxer.open(reader);
        demuxer.size = reader.size;
        debug('demux', 'opened', { format: demuxer.format, streams: demuxer.streams.length });
        return demuxer;
      } catch (e) {
        last = e;
        debug('demux', 'candidate failed', { name: Demuxer.name, message: e.message });
      }
    }
    throw last || badData('unrecognized input format');
  } catch (e) {
    await reader.close();
    throw wrap(e);
  }
}

export {
  openDemuxer,
};
