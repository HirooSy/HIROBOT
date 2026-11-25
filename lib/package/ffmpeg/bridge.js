import { run } from './lib/pipeline.js';
import { probe } from './lib/probe.js';
import { FFError } from './lib/errors.js';

const nativeInputs = new Set(['wav', 'flac', 'mp3', 'ogg', 'opus']);

const extensionOf = file => String(file).split('.').pop().toLowerCase();
const shouldFallback = error => error instanceof FFError && new Set(['EUNSUPPORTED', 'EFORMAT', 'EINVAL']).has(error.code);

const nativeEnabled = () => process.env.FFMPEG_NATIVE !== '0';

export function canConvertNatively(input, output) {
  return nativeEnabled() && nativeInputs.has(extensionOf(input)) && new Set(['wav', 'flac', 'ogg', 'opus']).has(extensionOf(output));
}

export async function convertNative(input, output) {
  if (!canConvertNatively(input, output)) return false;
  try {
    await run({ input, output });
    return true;
  } catch (error) {
    if (shouldFallback(error)) return false;
    throw error;
  }
}

function parsePcm16Wav(buffer, channels) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        tag: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format || format.bits !== 16 || format.channels !== channels || (format.tag !== 1 && format.tag !== 0xfffe)) return null;
      const end = Math.min(body + size, buffer.length);
      const length = Math.floor((end - body) / 2) * 2;
      const start = buffer.byteOffset + body;
      if (start % 2 === 0) return new Int16Array(buffer.buffer, start, length / 2);
      const bytes = new Uint8Array(length);
      bytes.set(buffer.subarray(body, body + length));
      return new Int16Array(bytes.buffer);
    }
    offset = body + size + (size & 1);
  }
  return null;
}

export async function decodePcm16(input, { sampleRate, channels = 1, maxBytes = Infinity }) {
  if (!nativeEnabled() || !nativeInputs.has(extensionOf(input))) return null;
  let info;
  try {
    info = await probe(input);
  } catch (error) {
    if (shouldFallback(error)) return null;
    throw error;
  }
  const duration = info.format.duration || 0;
  if (duration * sampleRate * channels * 2 > maxBytes) {
    throw new Error(`decoded audio exceeds ${maxBytes} bytes: ${input}`);
  }
  let result;
  try {
    result = await run({ input, output: { format: 'wav' }, sampleRate, channels, codec: 'pcm_s16le' });
  } catch (error) {
    if (shouldFallback(error)) return null;
    throw error;
  }
  return parsePcm16Wav(result.output, channels);
}
