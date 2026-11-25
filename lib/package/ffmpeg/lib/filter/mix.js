const sqrtHalf = Math.SQRT1_2;

function buildMatrix(inCh, outCh) {
  const m = [];
  for (let o = 0; o < outCh; o++) m.push(new Float64Array(inCh));
  if (outCh === 1) {
    for (let i = 0; i < inCh; i++) m[0][i] = 1 / inCh;
    return m;
  }
  if (inCh === 1) {
    for (let o = 0; o < outCh; o++) m[o][0] = 1;
    return m;
  }
  if (outCh === 2 && inCh > 2) {
    const left = new Float64Array(inCh);
    const right = new Float64Array(inCh);
    left[0] = 1;
    right[1] = 1;
    if (inCh === 3) {
      left[2] = sqrtHalf;
      right[2] = sqrtHalf;
    } else if (inCh === 4) {
      left[2] = sqrtHalf;
      right[3] = sqrtHalf;
    } else if (inCh === 5) {
      left[2] = sqrtHalf;
      right[2] = sqrtHalf;
      left[3] = sqrtHalf;
      right[4] = sqrtHalf;
    } else if (inCh >= 6) {
      left[2] = sqrtHalf;
      right[2] = sqrtHalf;
      left[4] = sqrtHalf;
      right[5] = sqrtHalf;
      if (inCh >= 8) {
        left[6] = sqrtHalf;
        right[7] = sqrtHalf;
      }
    }
    let peak = 0;
    for (const row of [left, right]) {
      let sum = 0;
      for (let i = 0; i < inCh; i++) sum += Math.abs(row[i]);
      if (sum > peak) peak = sum;
    }
    for (let i = 0; i < inCh; i++) {
      left[i] /= peak;
      right[i] /= peak;
    }
    m[0] = left;
    m[1] = right;
    return m;
  }
  for (let o = 0; o < Math.min(inCh, outCh); o++) m[o][o] = 1;
  return m;
}

class ChannelMixer {
  constructor(inCh, outCh) {
    this.inCh = inCh;
    this.outCh = outCh;
    this.matrix = buildMatrix(inCh, outCh);
    this.out = new Float64Array(0);
  }

  process(data, frames) {
    const inCh = this.inCh;
    const outCh = this.outCh;
    if (this.out.length < frames * outCh) this.out = new Float64Array(frames * outCh);
    const out = this.out;
    for (let o = 0; o < outCh; o++) {
      const row = this.matrix[o];
      const idx = [];
      for (let i = 0; i < inCh; i++) if (row[i] !== 0) idx.push(i);
      if (idx.length === 1 && row[idx[0]] === 1) {
        const src = idx[0];
        for (let f = 0, a = src, b = o; f < frames; f++, a += inCh, b += outCh) out[b] = data[a];
      } else if (idx.length === 0) {
        for (let f = 0, b = o; f < frames; f++, b += outCh) out[b] = 0;
      } else {
        for (let f = 0, b = o; f < frames; f++, b += outCh) {
          let s = 0;
          const base = f * inCh;
          for (let k = 0; k < idx.length; k++) s += row[idx[k]] * data[base + idx[k]];
          out[b] = s;
        }
      }
    }
    return { data: out, frames };
  }
}

export {
  ChannelMixer,
};
