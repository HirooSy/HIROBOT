import { run } from './lib/pipeline.js';
import { probe } from './lib/probe.js';
import { setDebug, isDebug } from './lib/debug.js';
import { FFError } from './lib/errors.js';
import { parseArgs, main } from './lib/cli.js';
import { canConvertNatively, convertNative, decodePcm16 } from './bridge.js';

export {
  run,
  run as convert,
  probe,
  setDebug,
  isDebug,
  FFError,
  parseArgs,
  main,
  canConvertNatively,
  convertNative,
  decodePcm16,
};
