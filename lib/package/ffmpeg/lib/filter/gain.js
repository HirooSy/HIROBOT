class Trim {
  constructor(skipFrames, maxFrames) {
    this.skip = Math.max(0, skipFrames);
    this.remaining = maxFrames === undefined ? Infinity : Math.max(0, maxFrames);
    this.done = this.remaining === 0;
  }

  process(data, frames, channels) {
    let from = 0;
    if (this.skip > 0) {
      const drop = Math.min(this.skip, frames);
      this.skip -= drop;
      from = drop;
    }
    let count = frames - from;
    if (count <= 0) return null;
    if (count > this.remaining) count = this.remaining;
    this.remaining -= count;
    if (this.remaining <= 0) this.done = true;
    if (count <= 0) return null;
    return { data: data.subarray(from * channels, (from + count) * channels), frames: count };
  }
}

class Gain {
  constructor(options, channels) {
    this.volume = options.volume === undefined ? 1 : options.volume;
    this.fadeIn = Math.max(0, options.fadeInFrames || 0);
    this.fadeOutStart = options.fadeOutFrames > 0 && options.totalFrames > 0 ? Math.max(0, options.totalFrames - options.fadeOutFrames) : Infinity;
    this.fadeOut = Math.max(0, options.fadeOutFrames || 0);
    this.totalFrames = options.totalFrames || 0;
    this.channels = channels;
    this.position = 0;
  }

  get active() {
    return this.volume !== 1 || this.fadeIn > 0 || this.fadeOut > 0;
  }

  process(data, frames) {
    const ch = this.channels;
    const start = this.position;
    const end = start + frames;
    this.position = end;
    const needFade = (this.fadeIn > 0 && start < this.fadeIn) || (this.fadeOut > 0 && end > this.fadeOutStart);
    if (!needFade) {
      if (this.volume === 1) return;
      const v = this.volume;
      for (let i = 0, n = frames * ch; i < n; i++) data[i] *= v;
      return;
    }
    for (let f = 0; f < frames; f++) {
      const idx = start + f;
      let g = this.volume;
      if (this.fadeIn > 0 && idx < this.fadeIn) g *= idx / this.fadeIn;
      if (idx >= this.fadeOutStart) {
        const rest = this.totalFrames - idx;
        g *= rest <= 0 ? 0 : rest / this.fadeOut;
      }
      const o = f * ch;
      for (let c = 0; c < ch; c++) data[o + c] *= g;
    }
  }
}

export {
  Trim,
  Gain,
};
