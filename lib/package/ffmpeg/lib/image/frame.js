import { badArg } from '../errors.js';

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function planeSize(width, height, hsub, vsub) {
  return { width: Math.ceil(width / hsub), height: Math.ceil(height / vsub) };
}

function createRgba(width, height) {
  if (!(width > 0 && height > 0)) throw badArg('invalid image size');
  return { format: 'rgba', width, height, hsub: 1, vsub: 1, planes: [{ data: new Uint8Array(width * height * 4), width, height }] };
}

function createGray(width, height) {
  if (!(width > 0 && height > 0)) throw badArg('invalid image size');
  return { format: 'gray', width, height, hsub: 1, vsub: 1, planes: [{ data: new Uint8Array(width * height), width, height }] };
}

function createYuv(width, height, hsub, vsub) {
  if (!(width > 0 && height > 0)) throw badArg('invalid image size');
  const c = planeSize(width, height, hsub, vsub);
  return {
    format: 'yuv',
    width,
    height,
    hsub,
    vsub,
    planes: [
      { data: new Uint8Array(width * height), width, height },
      { data: new Uint8Array(c.width * c.height), width: c.width, height: c.height },
      { data: new Uint8Array(c.width * c.height), width: c.width, height: c.height },
    ],
  };
}

function channelsOf(frame) {
  return frame.format === 'rgba' ? 4 : 1;
}

function upsamplePlane(plane, width, height) {
  if (plane.width === width && plane.height === height) return plane.data;
  const out = new Uint8Array(width * height);
  const sw = plane.width;
  const sh = plane.height;
  const src = plane.data;
  const xs = new Int32Array(width);
  const xw = new Uint8Array(width);
  const xn = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const f = ((x + 0.5) * sw) / width - 0.5;
    let x0 = Math.floor(f);
    const w = f - x0;
    let x1 = x0 + 1;
    if (x0 < 0) x0 = 0;
    if (x1 < 0) x1 = 0;
    if (x0 > sw - 1) x0 = sw - 1;
    if (x1 > sw - 1) x1 = sw - 1;
    xs[x] = x0;
    xn[x] = x1;
    xw[x] = Math.round(w * 256 > 255 ? 255 : w * 256);
  }
  for (let y = 0; y < height; y++) {
    const f = ((y + 0.5) * sh) / height - 0.5;
    let y0 = Math.floor(f);
    const wy = Math.round((f - y0) * 256);
    let y1 = y0 + 1;
    if (y0 < 0) y0 = 0;
    if (y1 < 0) y1 = 0;
    if (y0 > sh - 1) y0 = sh - 1;
    if (y1 > sh - 1) y1 = sh - 1;
    const r0 = y0 * sw;
    const r1 = y1 * sw;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const wx = xw[x];
      const a = src[r0 + xs[x]] * (256 - wx) + src[r0 + xn[x]] * wx;
      const b = src[r1 + xs[x]] * (256 - wx) + src[r1 + xn[x]] * wx;
      out[row + x] = (a * (256 - wy) + b * wy + 32768) >> 16;
    }
  }
  return out;
}

function toRgba(frame) {
  if (frame.format === 'rgba') return frame;
  const { width, height } = frame;
  const out = createRgba(width, height);
  const dst = out.planes[0].data;
  if (frame.format === 'gray') {
    const g = frame.planes[0].data;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      dst[j] = dst[j + 1] = dst[j + 2] = g[i];
      dst[j + 3] = 255;
    }
    return out;
  }
  const y = frame.planes[0].data;
  const cb = upsamplePlane(frame.planes[1], width, height);
  const cr = upsamplePlane(frame.planes[2], width, height);
  for (let i = 0, j = 0; i < y.length; i++, j += 4) {
    const yy = y[i];
    const u = cb[i] - 128;
    const v = cr[i] - 128;
    dst[j] = clamp8((yy + 1.402 * v + 0.5) | 0);
    dst[j + 1] = clamp8((yy - 0.344136 * u - 0.714136 * v + 0.5) | 0);
    dst[j + 2] = clamp8((yy + 1.772 * u + 0.5) | 0);
    dst[j + 3] = 255;
  }
  return out;
}

function toGray(frame) {
  if (frame.format === 'gray') return frame;
  const out = createGray(frame.width, frame.height);
  if (frame.format === 'yuv') {
    out.planes[0].data.set(frame.planes[0].data);
    return out;
  }
  const src = frame.planes[0].data;
  const dst = out.planes[0].data;
  for (let i = 0, j = 0; i < dst.length; i++, j += 4) {
    dst[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29 + 128) >> 8;
  }
  return out;
}

function toYuv(frame, hsub, vsub) {
  if (frame.format === 'yuv' && frame.hsub === hsub && frame.vsub === vsub) return frame;
  const rgba = frame.format === 'yuv' ? toRgba(frame) : frame;
  const { width, height } = rgba;
  const out = createYuv(width, height, hsub, vsub);
  const src = rgba.planes[0].data;
  const yp = out.planes[0].data;
  const cbp = out.planes[1];
  const crp = out.planes[2];
  const cw = cbp.width;
  const ch = cbp.height;
  const sumCb = new Float32Array(cw * ch);
  const sumCr = new Float32Array(cw * ch);
  const count = new Uint16Array(cw * ch);
  const gray = frame.format === 'gray';
  const gsrc = gray ? frame.planes[0].data : null;
  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / vsub);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let r;
      let g;
      let b;
      if (gray) {
        r = g = b = gsrc[i];
      } else {
        const j = i * 4;
        r = src[j];
        g = src[j + 1];
        b = src[j + 2];
      }
      yp[i] = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
      const k = cy * cw + Math.floor(x / hsub);
      sumCb[k] += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      sumCr[k] += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      count[k]++;
    }
  }
  for (let k = 0; k < count.length; k++) {
    cbp.data[k] = clamp8((sumCb[k] / count[k] + 0.5) | 0);
    crp.data[k] = clamp8((sumCr[k] / count[k] + 0.5) | 0);
  }
  return out;
}

function flatten(frame, background) {
  const rgba = toRgba(frame);
  const src = rgba.planes[0].data;
  const out = createRgba(rgba.width, rgba.height);
  const dst = out.planes[0].data;
  const bg = background || [0, 0, 0];
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
    } else {
      dst[i] = (src[i] * a + bg[0] * (255 - a) + 127) / 255;
      dst[i + 1] = (src[i + 1] * a + bg[1] * (255 - a) + 127) / 255;
      dst[i + 2] = (src[i + 2] * a + bg[2] * (255 - a) + 127) / 255;
    }
    dst[i + 3] = 255;
  }
  return out;
}

function hasAlpha(frame) {
  if (frame.format !== 'rgba') return false;
  const d = frame.planes[0].data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

export {
  clamp8,
  planeSize,
  createRgba,
  createGray,
  createYuv,
  channelsOf,
  upsamplePlane,
  toRgba,
  toGray,
  toYuv,
  flatten,
  hasAlpha,
};
