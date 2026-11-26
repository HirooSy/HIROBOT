import { run } from './pipeline.js';
import { probe } from './probe.js';
import { setDebug, debug } from './debug.js';
import { badArg } from './errors.js';

function parseArgs(argv) {
  const opts = { inputs: [], metadata: {} };
  const positional = [];
  const takes = (i, name) => {
    if (i + 1 >= argv.length) throw badArg('missing value for ' + name);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-i':
        opts.inputs.push(takes(i, a));
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
      case '-c:a':
      case '-acodec':
        opts.codec = takes(i, a);
        i++;
        break;
      case '-c:v':
      case '-vcodec':
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
        opts.format = takes(i, a);
        i++;
        break;
      case '-bits':
        opts.bitDepth = takes(i, a);
        i++;
        break;
      case '-volume':
        opts.volume = takes(i, a);
        i++;
        break;
      case '-fadein':
        opts.fadeIn = takes(i, a);
        i++;
        break;
      case '-fadeout':
        opts.fadeOut = takes(i, a);
        i++;
        break;
      case '-metadata': {
        const kv = takes(i, a);
        const eq = kv.indexOf('=');
        if (eq < 1) throw badArg('metadata must be key=value');
        opts.metadata[kv.slice(0, eq)] = kv.slice(eq + 1);
        i++;
        break;
      }
      case '-strip':
        opts.stripMetadata = true;
        break;
      case '-faststart':
        opts.faststart = true;
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
      case '-q':
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
      case '-debug':
        setDebug(true);
        break;
      default:
        positional.push(a);
    }
  }
  if (positional.length) {
    if (!opts.inputs.length && positional.length > 1) throw badArg('missing -i');
    opts.output = positional[positional.length - 1];
  }
  if (!opts.output) throw badArg('missing output');
  if (!opts.inputs.length) throw badArg('missing input');
  return opts;
}

async function main(argv) {
  try {
    if (argv[0] === 'probe') {
      if (argv.includes('-debug')) setDebug(true);
      const file = argv.slice(1).find((a) => a !== '-debug');
      if (!file) throw badArg('missing input');
      process.stdout.write(JSON.stringify(await probe(file), null, 2) + '\n');
      return 0;
    }
    await run(parseArgs(argv));
    return 0;
  } catch (e) {
    debug('cli', e && e.stack ? e.stack : String(e));
    return 1;
  }
}

export {
  parseArgs,
  main,
};
