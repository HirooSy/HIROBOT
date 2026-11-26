import { badArg, noSupport } from '../errors.js';
import { createRgba, createYuv, createGray, toRgba, planeSize } from '../image/frame.js';

const functions = {
  trunc: Math.trunc,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (v) => (v < 0 ? -Math.round(-v) : Math.round(v)),
  abs: Math.abs,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  log: Math.log,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => a % b,
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0),
  not: (a) => (a ? 0 : 1),
  if: (a, b, c) => (a ? b : c === undefined ? 0 : c),
  ifnot: (a, b, c) => (a ? (c === undefined ? 0 : c) : b),
  lerp: (a, b, t) => a + (b - a) * t,
  clip: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
};

function evaluate(text, vars) {
  const src = String(text).trim();
  let pos = 0;
  const peek = () => {
    while (pos < src.length && src[pos] === ' ') pos++;
    return src[pos];
  };
  const parseExpr = () => {
    let v = parseTerm();
    for (;;) {
      const c = peek();
      if (c === '+') {
        pos++;
        v += parseTerm();
      } else if (c === '-') {
        pos++;
        v -= parseTerm();
      } else return v;
    }
  };
  const parseTerm = () => {
    let v = parsePower();
    for (;;) {
      const c = peek();
      if (c === '*') {
        pos++;
        v *= parsePower();
      } else if (c === '/') {
        pos++;
        v /= parsePower();
      } else return v;
    }
  };
  const parsePower = () => {
    const base = parseUnary();
    if (peek() === '^') {
      pos++;
      return Math.pow(base, parsePower());
    }
    return base;
  };
  const parseUnary = () => {
    const c = peek();
    if (c === '-') {
      pos++;
      return -parseUnary();
    }
    if (c === '+') {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const c = peek();
    if (c === '(') {
      pos++;
      const v = parseExpr();
      if (peek() !== ')') throw badArg('invalid expression: ' + src);
      pos++;
      return v;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos));
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos));
    if (!id) throw badArg('invalid expression: ' + src);
    pos += id[0].length;
    const name = id[0];
    if (peek() === '(') {
      pos++;
      const args = [];
      if (peek() !== ')') {
        for (;;) {
          args.push(parseExpr());
          if (peek() === ',') {
            pos++;
            continue;
          }
          break;
        }
      }
      if (peek() !== ')') throw badArg('invalid expression: ' + src);
      pos++;
      if (!functions[name]) throw badArg('unknown function in expression: ' + name);
      return functions[name](...args);
    }
    if (name === 'PI') return Math.PI;
    if (name === 'E') return Math.E;
    if (!(name in vars)) throw badArg('unknown variable in expression: ' + name);
    return vars[name];
  };
  const result = parseExpr();
  if (peek() !== undefined) throw badArg('invalid expression: ' + src);
  if (!Number.isFinite(result)) throw badArg('expression is not finite: ' + src);
  return result;
}

function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      continue;
    }
    if (c === "'") {
      quote = !quote;
      continue;
    }
    if (!quote) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === sep && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

const positional = {
  scale: ['w', 'h', 'flags'],
  crop: ['w', 'h', 'x', 'y', 'keep_aspect'],
  pad: ['width', 'height', 'x', 'y', 'color'],
  transpose: ['dir'],
  format: ['pix_fmts'],
  setsar: ['sar'],
  setdar: ['dar'],
  fps: ['fps'],
  trim: ['start', 'end'],
};

const aliases = { w: 'w', h: 'h', out_w: 'w', out_h: 'h', width: 'width', height: 'height' };

function parseFilters(text) {
  if (text === undefined || text === null || text === '') return [];
  const out = [];
  for (const raw of splitTop(String(text), ',')) {
    const part = raw.trim();
    if (!part) continue;
    if (/[\[\];]/.test(part) || part.includes(' ') && /\[/.test(part)) throw noSupport('filter graphs are not supported');
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const args = {};
    if (eq >= 0) {
      const names = positional[name] || [];
      let index = 0;
      let named = false;
      for (const item of splitTop(part.slice(eq + 1), ':')) {
        const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(item);
        if (kv) {
          named = true;
          args[aliases[kv[1]] || kv[1]] = kv[2].trim();
        } else {
          if (named) throw badArg('positional argument after named argument in filter ' + name);
          const key = names[index++];
          if (!key) throw badArg('too many arguments for filter ' + name);
          args[key] = item.trim();
        }
      }
    }
    out.push({ name, args });
  }
  return out;
}

const bicubic = (b, c) => (x) => {
  x = Math.abs(x);
  if (x < 1) return ((12 - 9 * b - 6 * c) * x * x * x + (-18 + 12 * b + 6 * c) * x * x + (6 - 2 * b)) / 6;
  if (x < 2) return ((-b - 6 * c) * x * x * x + (6 * b + 30 * c) * x * x + (-12 * b - 48 * c) * x + (8 * b + 24 * c)) / 6;
  return 0;
};

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

const kernels = {
  bicubic: { radius: 2, fn: bicubic(0, 0.6) },
  bilinear: { radius: 1, fn: (x) => Math.max(0, 1 - Math.abs(x)) },
  fast_bilinear: { radius: 1, fn: (x) => Math.max(0, 1 - Math.abs(x)) },
  bicublin: { radius: 2, fn: bicubic(0, 0.6) },
  neighbor: { radius: 0.5, fn: (x) => (x >= -0.5 && x < 0.5 ? 1 : 0), point: true },
  area: { radius: 0.5, fn: (x) => (Math.abs(x) < 0.5 ? 1 : 0), box: true },
  lanczos: { radius: 3, fn: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
  spline: { radius: 2, fn: bicubic(1, 0) },
  gauss: { radius: 2, fn: (x) => Math.exp(-2 * x * x) },
};

function buildTaps(srcLen, dstLen, kernel) {
  const ratio = srcLen / dstLen;
  const sf = kernel.point ? 1 : Math.max(1, ratio);
  const radius = kernel.radius * sf;
  const maxTaps = Math.ceil(radius * 2) + 2;
  const index = new Int32Array(dstLen * maxTaps);
  const weight = new Float32Array(dstLen * maxTaps);
  const count = new Int32Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * ratio - 0.5;
    if (kernel.point) {
      index[d * maxTaps] = Math.min(srcLen - 1, Math.max(0, Math.floor((d + 0.5) * ratio)));
      weight[d * maxTaps] = 1;
      count[d] = 1;
      continue;
    }
    const first = Math.ceil(center - radius);
    const last = Math.floor(center + radius);
    let n = 0;
    let sum = 0;
    for (let s = first; s <= last && n < maxTaps; s++) {
      const w = kernel.fn((s - center) / sf);
      if (w === 0) continue;
      index[d * maxTaps + n] = s < 0 ? 0 : s > srcLen - 1 ? srcLen - 1 : s;
      weight[d * maxTaps + n] = w;
      sum += w;
      n++;
    }
    if (n === 0 || sum === 0) {
      index[d * maxTaps] = Math.min(srcLen - 1, Math.max(0, Math.round(center)));
      weight[d * maxTaps] = 1;
      n = 1;
      sum = 1;
    }
    for (let i = 0; i < n; i++) weight[d * maxTaps + i] /= sum;
    count[d] = n;
  }
  return { index, weight, count, maxTaps };
}

function scalePlane(plane, dw, dh, channels, kernel) {
  const sw = plane.width;
  const sh = plane.height;
  if (sw === dw && sh === dh) return plane;
  const src = plane.data;
  const hx = buildTaps(sw, dw, kernel);
  const vy = buildTaps(sh, dh, kernel);
  const tmp = new Float32Array(dw * sh * channels);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * channels;
    for (let x = 0; x < dw; x++) {
      const n = hx.count[x];
      const base = x * hx.maxTaps;
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let t = 0; t < n; t++) acc += src[row + hx.index[base + t] * channels + c] * hx.weight[base + t];
        tmp[(y * dw + x) * channels + c] = acc;
      }
    }
  }
  const out = new Uint8Array(dw * dh * channels);
  const stride = dw * channels;
  for (let y = 0; y < dh; y++) {
    const n = vy.count[y];
    const base = y * vy.maxTaps;
    for (let i = 0; i < stride; i++) {
      let acc = 0;
      for (let t = 0; t < n; t++) acc += tmp[vy.index[base + t] * stride + i] * vy.weight[base + t];
      const v = Math.round(acc);
      out[y * stride + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { data: out, width: dw, height: dh };
}

function frameVars(frame) {
  const hsub = frame.format === 'yuv' ? frame.hsub : 1;
  const vsub = frame.format === 'yuv' ? frame.vsub : 1;
  return { iw: frame.width, ih: frame.height, in_w: frame.width, in_h: frame.height, a: frame.width / frame.height, sar: 1, dar: frame.width / frame.height, hsub, vsub, n: 0, t: 0, pos: 0 };
}

function adjustDimensions(args, frame) {
  const vars = frameVars(frame);
  const evalDim = (key) => (args[key] === undefined || args[key] === '' ? 0 : evaluate(args[key], vars));
  vars.ow = vars.out_w = 0;
  vars.oh = vars.out_h = 0;
  let w = evalDim('w');
  vars.ow = vars.out_w = w;
  let h = evalDim('h');
  vars.oh = vars.out_h = h;
  if (/\boh\b|\bout_h\b/.test(String(args.w || ''))) w = evalDim('w');
  w = Math.trunc(w);
  h = Math.trunc(h);
  let factorW = 1;
  let factorH = 1;
  if (w < -1) factorW = -w;
  if (h < -1) factorH = -h;
  if (w < 0 && h < 0) w = h = 0;
  if (!(w | h)) {
    w = frame.width;
    h = frame.height;
  } else if (w === 0) {
    w = frame.width;
  } else if (h === 0) {
    h = frame.height;
  }
  if (w < 0) w = Math.round(((h * frame.width) / frame.height) / factorW) * factorW || frame.width;
  else if (h < 0) h = Math.round(((w * frame.height) / frame.width) / factorH) * factorH || frame.height;
  const mode = args.force_original_aspect_ratio || 'disable';
  if (mode === 'increase' || mode === 'decrease') {
    const tmpW = (h * frame.width) / frame.height;
    const tmpH = (w * frame.height) / frame.width;
    if (mode === 'decrease') {
      w = Math.min(tmpW, w);
      h = Math.min(tmpH, h);
    } else {
      w = Math.max(tmpW, w);
      h = Math.max(tmpH, h);
    }
    const div = args.force_divisible_by ? Math.max(1, Math.trunc(evaluate(args.force_divisible_by, vars))) : 1;
    w = Math.round(w / div) * div || div;
    h = Math.round(h / div) * div || div;
  } else if (mode !== 'disable') throw badArg('invalid force_original_aspect_ratio: ' + mode);
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function applyScale(frame, args) {
  const { w, h } = adjustDimensions(args, frame);
  const flags = String(args.flags || 'bicubic').split('+')[0].toLowerCase();
  const kernel = kernels[flags];
  if (!kernel) throw noSupport('unsupported scaling flag: ' + flags);
  if (w === frame.width && h === frame.height) return frame;
  if (frame.format === 'rgba') {
    const p = scalePlane(frame.planes[0], w, h, 4, kernel);
    return { format: 'rgba', width: w, height: h, hsub: 1, vsub: 1, planes: [p] };
  }
  if (frame.format === 'gray') {
    const p = scalePlane(frame.planes[0], w, h, 1, kernel);
    return { format: 'gray', width: w, height: h, hsub: 1, vsub: 1, planes: [p] };
  }
  const c = planeSize(w, h, frame.hsub, frame.vsub);
  return {
    format: 'yuv',
    width: w,
    height: h,
    hsub: frame.hsub,
    vsub: frame.vsub,
    planes: [scalePlane(frame.planes[0], w, h, 1, kernel), scalePlane(frame.planes[1], c.width, c.height, 1, kernel), scalePlane(frame.planes[2], c.width, c.height, 1, kernel)],
  };
}

function cropPlane(plane, x, y, w, h, channels) {
  const out = new Uint8Array(w * h * channels);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * plane.width + x) * channels;
    out.set(plane.data.subarray(s, s + w * channels), r * w * channels);
  }
  return { data: out, width: w, height: h };
}

function rint(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function applyCrop(frame, args) {
  const vars = frameVars(frame);
  const dim = (key, fallback) => (args[key] === undefined || args[key] === '' ? fallback : evaluate(args[key], vars));
  vars.ow = vars.out_w = frame.width;
  vars.oh = vars.out_h = frame.height;
  let w = rint(dim('w', frame.width));
  let h = rint(dim('h', frame.height));
  vars.ow = vars.out_w = vars.w = w;
  vars.oh = vars.out_h = vars.h = h;
  w = rint(dim('w', frame.width));
  h = rint(dim('h', frame.height));
  if (w <= 0 || h <= 0 || w > frame.width || h > frame.height) throw badArg('invalid crop size ' + w + 'x' + h);
  vars.ow = vars.out_w = vars.w = w;
  vars.oh = vars.out_h = vars.h = h;
  let x = rint(dim('x', (frame.width - w) / 2));
  let y = rint(dim('y', (frame.height - h) / 2));
  x = Math.min(Math.max(0, x), frame.width - w);
  y = Math.min(Math.max(0, y), frame.height - h);
  if (frame.format === 'yuv') {
    x -= x % frame.hsub;
    y -= y % frame.vsub;
  }
  if (x === 0 && y === 0 && w === frame.width && h === frame.height) return frame;
  if (frame.format === 'rgba') return { format: 'rgba', width: w, height: h, hsub: 1, vsub: 1, planes: [cropPlane(frame.planes[0], x, y, w, h, 4)] };
  if (frame.format === 'gray') return { format: 'gray', width: w, height: h, hsub: 1, vsub: 1, planes: [cropPlane(frame.planes[0], x, y, w, h, 1)] };
  const c = planeSize(w, h, frame.hsub, frame.vsub);
  return {
    format: 'yuv',
    width: w,
    height: h,
    hsub: frame.hsub,
    vsub: frame.vsub,
    planes: [
      cropPlane(frame.planes[0], x, y, w, h, 1),
      cropPlane(frame.planes[1], x / frame.hsub, y / frame.vsub, c.width, c.height, 1),
      cropPlane(frame.planes[2], x / frame.hsub, y / frame.vsub, c.width, c.height, 1),
    ],
  };
}

const namedColors = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128], transparent: [0, 0, 0, 0] };

function parseColor(text) {
  const [base, alphaText] = String(text || 'black').split('@');
  let rgb;
  const lower = base.toLowerCase();
  if (namedColors[lower]) rgb = namedColors[lower].slice();
  else {
    const hex = /^(?:#|0x)([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(base);
    if (!hex) throw badArg('invalid color: ' + text);
    const n = parseInt(hex[1], 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (hex[2]) rgb[3] = parseInt(hex[2], 16);
  }
  if (rgb.length === 3) rgb.push(255);
  if (alphaText !== undefined) rgb[3] = Math.round(Math.min(1, Math.max(0, Number(alphaText))) * 255);
  return rgb;
}

function applyPad(frame, args) {
  const src = toRgba(frame);
  const vars = frameVars(src);
  const dim = (key, fallback) => (args[key] === undefined || args[key] === '' ? fallback : evaluate(args[key], vars));
  let w = Math.trunc(dim('width', src.width));
  let h = Math.trunc(dim('height', src.height));
  if (w <= 0) w = src.width;
  if (h <= 0) h = src.height;
  w = Math.max(w, src.width);
  h = Math.max(h, src.height);
  vars.ow = vars.out_w = w;
  vars.oh = vars.out_h = h;
  let x = Math.trunc(dim('x', 0));
  let y = Math.trunc(dim('y', 0));
  if (x < 0) x = Math.trunc((w - src.width) / 2);
  if (y < 0) y = Math.trunc((h - src.height) / 2);
  x = Math.min(x, w - src.width);
  y = Math.min(y, h - src.height);
  const color = parseColor(args.color);
  const out = createRgba(w, h);
  const d = out.planes[0].data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = color[0];
    d[i + 1] = color[1];
    d[i + 2] = color[2];
    d[i + 3] = color[3];
  }
  const s = src.planes[0].data;
  for (let r = 0; r < src.height; r++) d.set(s.subarray(r * src.width * 4, (r + 1) * src.width * 4), ((y + r) * w + x) * 4);
  return out;
}

function mapPlanes(frame, fn) {
  const ch = frame.format === 'rgba' ? 4 : 1;
  return fn(frame, ch);
}

function flipFrame(frame, horizontal) {
  const planes = frame.planes.map((p) => {
    const ch = frame.format === 'rgba' ? 4 : 1;
    const out = new Uint8Array(p.data.length);
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const sx = horizontal ? p.width - 1 - x : x;
        const sy = horizontal ? y : p.height - 1 - y;
        for (let c = 0; c < ch; c++) out[(y * p.width + x) * ch + c] = p.data[(sy * p.width + sx) * ch + c];
      }
    }
    return { data: out, width: p.width, height: p.height };
  });
  return Object.assign({}, frame, { planes });
}

function transposeFrame(frame, dir) {
  const d = typeof dir === 'string' && /^\d+$/.test(dir) ? Number(dir) : { cclock_flip: 0, clock: 1, cclock: 2, clock_flip: 3 }[dir];
  if (d === undefined) throw badArg('invalid transpose direction');
  const ch = frame.format === 'rgba' ? 4 : 1;
  const planes = frame.planes.map((p) => {
    const ow = p.height;
    const oh = p.width;
    const out = new Uint8Array(p.data.length);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        let sx;
        let sy;
        if (d === 0) {
          sx = y;
          sy = x;
          sy = p.height - 1 - sy;
        } else if (d === 1) {
          sx = y;
          sy = p.height - 1 - x;
        } else if (d === 2) {
          sx = p.width - 1 - y;
          sy = x;
        } else {
          sx = p.width - 1 - y;
          sy = p.height - 1 - x;
        }
        for (let c = 0; c < ch; c++) out[(y * ow + x) * ch + c] = p.data[(sy * p.width + sx) * ch + c];
      }
    }
    return { data: out, width: ow, height: oh };
  });
  if (frame.format === 'yuv' && frame.hsub !== frame.vsub) throw noSupport('transpose of non-square chroma subsampling is not supported');
  return Object.assign({}, frame, { width: frame.height, height: frame.width, planes });
}

const noopFilters = new Set(['setsar', 'setdar', 'fps', 'setpts', 'null', 'unsharp_none']);

function applyFilters(frame, filters, hints) {
  let cur = frame;
  for (const f of filters) {
    if (f.name === 'scale') cur = applyScale(cur, f.args);
    else if (f.name === 'crop') cur = applyCrop(cur, f.args);
    else if (f.name === 'pad') cur = applyPad(cur, f.args);
    else if (f.name === 'hflip') cur = flipFrame(cur, true);
    else if (f.name === 'vflip') cur = flipFrame(cur, false);
    else if (f.name === 'transpose') cur = transposeFrame(cur, f.args.dir === undefined ? '0' : f.args.dir);
    else if (f.name === 'format') {
      if (hints) hints.pixFmt = String(f.args.pix_fmts || '').split(/[|,]/)[0];
    } else if (noopFilters.has(f.name)) continue;
    else throw noSupport('unsupported filter: ' + f.name);
  }
  return cur;
}

function outputSize(filters, width, height) {
  let w = width;
  let h = height;
  for (const f of filters) {
    if (f.name === 'scale') {
      const r = adjustDimensions(f.args, { width: w, height: h });
      w = r.w;
      h = r.h;
    } else if (!(f.name === 'format' || noopFilters.has(f.name))) return null;
  }
  return { width: w, height: h };
}

export { evaluate, parseFilters, applyFilters, parseColor, kernels, outputSize };
