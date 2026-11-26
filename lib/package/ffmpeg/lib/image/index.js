import { badData, noSupport, badArg } from '../errors.js';
import { decodeJpeg, encodeJpeg, probeJpeg } from './jpeg.js';
import { decodePng, encodePng, probePng, isPng } from './png.js';
import { decodeGif, decodeGifFrame, probeGif, isGif } from './gif.js';
import { decodeBmp, encodeBmp, probeBmp, isBmp } from './bmp.js';

const codecNames = { jpeg: 'mjpeg', png: 'png', gif: 'gif', bmp: 'bmp' };

const outputNames = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  mjpeg: 'jpeg',
  png: 'png',
  bmp: 'bmp',
};

function detectImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (isPng(buf)) return 'png';
  if (isGif(buf)) return 'gif';
  if (isBmp(buf)) return 'bmp';
  return null;
}

function probeImage(buf) {
  const format = detectImage(buf);
  if (!format) return null;
  let info = null;
  if (format === 'jpeg') info = probeJpeg(buf);
  else if (format === 'png') info = probePng(buf);
  else if (format === 'gif') info = probeGif(buf);
  else info = probeBmp(buf);
  if (!info) return null;
  return { format, codec: codecNames[format], width: info.width, height: info.height };
}

function decodeImage(buf, options = {}) {
  const format = detectImage(buf);
  if (!format) throw badData('unrecognized image format');
  if (format === 'jpeg') return decodeJpeg(buf);
  if (format === 'png') return decodePng(buf);
  if (format === 'bmp') return decodeBmp(buf);
  const gif = decodeGif(buf, { maxFrames: options.maxFrames || 1 });
  return gif.frames[0].frame;
}

function encodeImage(frame, format, options = {}) {
  if (format === 'jpeg') return encodeJpeg(frame, options);
  if (format === 'png') return encodePng(frame, options);
  if (format === 'bmp') return encodeBmp(frame);
  throw noSupport('no image encoder for ' + format);
}

function outputFormatOf(name) {
  if (!name) return null;
  return outputNames[String(name).toLowerCase()] || null;
}

function subsamplingOf(pixFmt) {
  if (!pixFmt) return null;
  const p = String(pixFmt).toLowerCase();
  if (p === 'gray' || p === 'gray8' || p === 'y8') return { gray: true };
  if (/^yuvj?420p$/.test(p)) return { hsub: 2, vsub: 2 };
  if (/^yuvj?422p$/.test(p)) return { hsub: 2, vsub: 1 };
  if (/^yuvj?444p$/.test(p)) return { hsub: 1, vsub: 1 };
  if (/^yuvj?440p$/.test(p)) return { hsub: 1, vsub: 2 };
  return null;
}

export { detectImage, probeImage, decodeImage, decodeGifFrame, encodeImage, outputFormatOf, subsamplingOf, codecNames };
