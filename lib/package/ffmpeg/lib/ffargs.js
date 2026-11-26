import { badArg, noSupport } from './errors.js';
import { parseHeaders } from './net.js';

const ignoredFlags = new Set(['-nostdin', '-hide_banner', '-nostats', '-stats', '-sn', '-dn', '-ignore_unknown']);
const ignoredWithValue = new Set(['-loglevel', '-v', '-threads', '-allowed_extensions', '-protocol_whitelist', '-max_muxing_queue_size', '-strict', '-avoid_negative_ts', '-fflags', '-tag:v', '-tag:a', '-bufsize', '-maxrate', '-minrate', '-timeout', '-rw_timeout', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-multiple_requests', '-seekable', '-http_persistent', '-live_start_index', '-extension_picky']);
const encoderTuning = new Set(['-preset', '-crf', '-profile:v', '-level', '-level:v', '-b:v', '-b:a', '-maxrate:v', '-g', '-r', '-tune', '-qp', '-x264opts', '-x264-params', '-movflags:v', '-af', '-aq', '-vsync', '-fps_mode', '-async']);

function parseMap(text) {
  const optional = text.endsWith('?');
  const body = optional ? text.slice(0, -1) : text;
  if (body.startsWith('-')) throw noSupport('negative map is not supported');
  const m = /^(\d+)(?::([vasVAS])(?::(\d+))?)?$/.exec(body);
  if (!m) throw noSupport('unsupported map: ' + text);
  const type = m[2] ? { v: 'video', a: 'audio' }[m[2].toLowerCase()] : undefined;
  if (m[2] && !type) throw noSupport('unsupported map: ' + text);
  return { input: Number(m[1]), type, nth: m[3] === undefined ? undefined : Number(m[3]), optional, text };
}

function parseFfmpegArgs(argv) {
  const opts = { inputs: [], metadata: {}, merge: false, compat: true, net: {}, maps: [] };
  const inputNet = [];
  let pending = {};
  const positional = [];
  const takes = (i, name) => {
    if (i + 1 >= argv.length) throw badArg('missing value for ' + name);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (ignoredFlags.has(a)) continue;
    if (ignoredWithValue.has(a)) {
      i++;
      continue;
    }
    if (encoderTuning.has(a)) {
      opts.tuning = opts.tuning || {};
      opts.tuning[a] = takes(i, a);
      i++;
      continue;
    }
    switch (a) {
      case '-i':
        opts.inputs.push(takes(i, a));
        inputNet.push(pending);
        pending = {};
        i++;
        break;
      case '-ss':
        opts.start = takes(i, a);
        i++;
        break;
      case '-t':
        opts.duration = takes(i, a);
        i++;
        break;
      case '-to':
        opts.end = takes(i, a);
        i++;
        break;
      case '-c':
      case '-codec':
        opts.codec = takes(i, a);
        opts.videoCodec = opts.codec;
        i++;
        break;
      case '-c:a':
      case '-acodec':
      case '-codec:a':
        opts.codec = takes(i, a);
        i++;
        break;
      case '-c:v':
      case '-vcodec':
      case '-codec:v':
        opts.videoCodec = takes(i, a);
        i++;
        break;
      case '-ar':
        opts.sampleRate = takes(i, a);
        i++;
        break;
      case '-ac':
        opts.channels = takes(i, a);
        i++;
        break;
      case '-f':
        if (!inputNet.length && positional.length === 0 && !opts.inputs.length) {
          const v = takes(i, a);
          if (v === 'lavfi' || v === 'concat' || v === 'image2' || v === 'rawvideo') throw noSupport('unsupported input format ' + v);
          pending.format = v;
        } else opts.format = takes(i, a);
        i++;
        break;
      case '-metadata':
      case '-metadata:g': {
        const kv = takes(i, a);
        const eq = kv.indexOf('=');
        if (eq < 1) throw badArg('metadata must be key=value');
        opts.metadata[kv.slice(0, eq)] = kv.slice(eq + 1);
        i++;
        break;
      }
      case '-metadata:s:v':
      case '-metadata:s:a':
      case '-metadata:s:v:0':
      case '-metadata:s:a:0':
        i++;
        break;
      case '-map_metadata':
        if (takes(i, a) === '-1') opts.stripMetadata = true;
        else throw noSupport('unsupported map_metadata');
        i++;
        break;
      case '-map':
        opts.maps.push(parseMap(takes(i, a)));
        i++;
        break;
      case '-movflags': {
        const v = takes(i, a);
        if (/faststart/.test(v)) opts.faststart = true;
        i++;
        break;
      }
      case '-bsf':
      case '-bsf:a':
      case '-bsf:v': {
        const v = takes(i, a);
        if (v !== 'aac_adtstoasc') throw noSupport('unsupported bitstream filter ' + v);
        i++;
        break;
      }
      case '-shortest':
        opts.shortest = true;
        break;
      case '-user_agent':
        opts.net.userAgent = takes(i, a);
        i++;
        break;
      case '-headers':
        Object.assign((opts.net.headers = opts.net.headers || {}), parseHeaders(takes(i, a)));
        i++;
        break;
      case '-referer':
        opts.net.referer = takes(i, a);
        i++;
        break;
      case '-vf':
      case '-filter:v':
        opts.videoFilter = takes(i, a);
        i++;
        break;
      case '-vframes':
      case '-frames:v':
        opts.frames = takes(i, a);
        i++;
        break;
      case '-q:v':
      case '-qscale:v':
        opts.qscale = takes(i, a);
        i++;
        break;
      case '-pix_fmt':
        opts.pixFmt = takes(i, a);
        i++;
        break;
      case '-compression_level':
        opts.compressionLevel = takes(i, a);
        i++;
        break;
      case '-vn':
        opts.noVideo = true;
        break;
      case '-an':
        opts.noAudio = true;
        break;
      case '-n':
        opts.overwrite = false;
        break;
      case '-y':
        opts.overwrite = true;
        break;
      default:
        if (a.startsWith('-') && a.length > 1) throw noSupport('unsupported option ' + a);
        positional.push(a);
    }
  }
  if (inputNet.some((x) => x.format)) throw noSupport('unsupported input format option');
  if (!opts.inputs.length) throw badArg('missing input');
  if (!positional.length) throw badArg('missing output');
  opts.output = positional[positional.length - 1];
  if (positional.length > 1) throw noSupport('multiple outputs are not supported');
  opts.merge = opts.inputs.length > 1;
  const ext = String(opts.format || opts.output.split('.').pop()).toLowerCase();
  if (['mp4', 'm4v', 'mov'].includes(ext)) {
    if (!opts.videoCodec && !opts.noVideo) opts.videoCodec = 'libx264';
    if (!opts.codec && !opts.noAudio) opts.codec = 'aac';
  }
  return opts;
}

export { parseFfmpegArgs };
