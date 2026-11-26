const phases = 512;
const beta = 9;

function bessel0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

function sinc(x) {
  if (x === 0) return 1;
  const a = Math.PI * x;
  return Math.sin(a) / a;
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function buildKernel(inRate, outRate) {
  const cutoff = Math.min(1, outRate / inRate) * 0.97;
  const half = Math.ceil(12 / cutoff);
  const taps = half * 2;
  const g = gcd(inRate, outRate);
  const upFactor = outRate / g;
  const exact = upFactor * taps <= 2000000;
  const rows = exact ? upFactor : phases + 1;
  const divisor = exact ? upFactor : phases;
  const table = new Float64Array(rows * taps);
  const norm = bessel0(beta);
  for (let p = 0; p < rows; p++) {
    const frac = p / divisor;
    let sum = 0;
    const row = p * taps;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - frac;
      const r = x / half;
      const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / norm;
      const v = cutoff * sinc(cutoff * x) * win;
      table[row + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) table[row + k] /= sum;
  }
  return { half, taps, table, exact, upFactor, downFactor: inRate / g };
}

class Resampler {
  constructor(inRate, outRate, channels) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.channels = channels;
    const k = buildKernel(inRate, outRate);
    this.half = k.half;
    this.taps = k.taps;
    this.table = k.table;
    this.exact = k.exact;
    this.upFactor = k.upFactor;
    this.downFactor = k.downFactor;
    this.coef = new Float64Array(this.taps);
    this.buf = new Float64Array(Math.max(4096, this.taps * 2) * channels);
    this.bufFrames = this.half;
    this.base = -this.half;
    this.outCount = 0;
    this.totalIn = 0;
    this.out = new Float64Array(0);
  }

  append(data, frames) {
    const ch = this.channels;
    const need = (this.bufFrames + frames) * ch;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = new Float64Array(cap);
      next.set(this.buf.subarray(0, this.bufFrames * ch));
      this.buf = next;
    }
    if (data) this.buf.set(data.subarray(0, frames * ch), this.bufFrames * ch);
    else this.buf.fill(0, this.bufFrames * ch, need);
    this.bufFrames += frames;
  }

  run(limit) {
    const ch = this.channels;
    const half = this.half;
    const taps = this.taps;
    const table = this.table;
    const coef = this.coef;
    const inRate = this.inRate;
    const outRate = this.outRate;
    const availEnd = this.base + this.bufFrames;
    const maxOut = Math.ceil(((availEnd + 1) * outRate) / inRate) - this.outCount + 2;
    if (this.out.length < maxOut * ch) this.out = new Float64Array(maxOut * ch);
    const out = this.out;
    const buf = this.buf;
    let produced = 0;
    const exact = this.exact;
    const upFactor = this.upFactor;
    const downFactor = this.downFactor;
    for (;;) {
      let i;
      let tab;
      let off;
      if (exact) {
        const num = this.outCount * downFactor;
        i = Math.floor(num / upFactor);
        if (limit !== undefined && i >= limit) break;
        if (i + half >= availEnd) break;
        tab = table;
        off = (num - i * upFactor) * taps;
      } else {
        const num = this.outCount * inRate;
        i = Math.floor(num / outRate);
        if (limit !== undefined && i >= limit) break;
        if (i + half >= availEnd) break;
        const phasePos = ((num - i * outRate) / outRate) * phases;
        const p = Math.floor(phasePos);
        const w = phasePos - p;
        const r0 = p * taps;
        const r1 = r0 + taps;
        for (let k = 0; k < taps; k++) coef[k] = table[r0 + k] * (1 - w) + table[r1 + k] * w;
        tab = coef;
        off = 0;
      }
      const local = (i - half + 1 - this.base) * ch;
      if (ch === 1) {
        let s = 0;
        for (let k = 0; k < taps; k++) s += tab[off + k] * buf[local + k];
        out[produced] = s;
      } else if (ch === 2) {
        let s0 = 0;
        let s1 = 0;
        for (let k = 0, o = local; k < taps; k++, o += 2) {
          const c = tab[off + k];
          s0 += c * buf[o];
          s1 += c * buf[o + 1];
        }
        out[produced * 2] = s0;
        out[produced * 2 + 1] = s1;
      } else {
        for (let c = 0; c < ch; c++) {
          let s = 0;
          for (let k = 0, o = local + c; k < taps; k++, o += ch) s += tab[off + k] * buf[o];
          out[produced * ch + c] = s;
        }
      }
      produced++;
      this.outCount++;
    }
    const keepFrom = (exact ? Math.floor((this.outCount * downFactor) / upFactor) : Math.floor((this.outCount * inRate) / outRate)) - half + 1;
    const drop = Math.min(this.bufFrames, Math.max(0, keepFrom - this.base));
    if (drop > 0) {
      buf.copyWithin(0, drop * ch, this.bufFrames * ch);
      this.bufFrames -= drop;
      this.base += drop;
    }
    return { data: out, frames: produced };
  }

  process(data, frames) {
    this.totalIn += frames;
    this.append(data, frames);
    return this.run(undefined);
  }

  flush() {
    const total = this.totalIn;
    this.append(null, this.half + 1);
    return this.run(total);
  }
}

export {
  Resampler,
};
