function parseMpaHeader(buf, off) {
  if (off + 4 > buf.length) return null;
  const b0 = buf[off];
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const brIndex = b2 >> 4;
  const srIndex = (b2 >> 2) & 3;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const layer = 4 - layerBits;
  const mpeg1 = versionBits === 3;
  const bitrate = ({
  '1:1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1:2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1:3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2:1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2:2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2:3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
})[(mpeg1 ? '1' : '2') + ':' + layer][brIndex] * 1000;
  const sampleRate = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[versionBits][srIndex];
  const padding = (b2 >> 1) & 1;
  const mode = b3 >> 6;
  let frameLen;
  let samples;
  if (layer === 1) {
    frameLen = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samples = 384;
  } else if (layer === 2) {
    frameLen = Math.floor((144 * bitrate) / sampleRate) + padding;
    samples = 1152;
  } else {
    frameLen = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
    samples = mpeg1 ? 1152 : 576;
  }
  return {
    versionBits,
    mpeg1,
    layer,
    protection: (b1 & 1) === 0,
    bitrate,
    sampleRate,
    padding,
    mode,
    channels: mode === 3 ? 1 : 2,
    frameLen,
    samples,
    b1,
    b2,
    b3,
  };
}

function sideInfoSize(h) {
  if (h.mpeg1) return h.channels === 1 ? 17 : 32;
  return h.channels === 1 ? 9 : 17;
}

export {
  parseMpaHeader,
  sideInfoSize,
};
