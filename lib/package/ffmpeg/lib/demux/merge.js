import { badArg } from '../errors.js';

function matches(spec, stream, perType) {
  if (spec.type && stream.type !== spec.type) return false;
  if (spec.nth !== undefined && perType !== spec.nth) return false;
  return true;
}

class MergedDemuxer {
  constructor(demuxers, maps, options = {}) {
    this.demuxers = demuxers;
    this.format = demuxers[0].format;
    this.tags = demuxers[0].tags || {};
    this.streams = [];
    this.pending = demuxers.map(() => null);
    this.finished = demuxers.map(() => false);
    this.shortest = Boolean(options.shortest);
    this.duration = Math.max(0, ...demuxers.map((d) => d.duration || 0));
    this.routes = demuxers.map(() => new Map());
    const picks = [];
    if (maps && maps.length) {
      for (const m of maps) {
        const d = demuxers[m.input];
        if (!d) throw badArg('map refers to missing input ' + m.input);
        const counters = { audio: 0, video: 0 };
        let found = false;
        for (const s of d.streams) {
          const n = counters[s.type]++;
          if (matches(m, s, n)) {
            picks.push({ input: m.input, stream: s });
            found = true;
          }
        }
        if (!found && !m.optional) throw badArg('map matches no streams: ' + m.text);
      }
    } else {
      for (const type of ['video', 'audio']) {
        for (let k = 0; k < demuxers.length; k++) {
          const s = demuxers[k].streams.find((x) => x.type === type);
          if (s) {
            picks.push({ input: k, stream: s });
            break;
          }
        }
      }
    }
    picks.sort((a, b) => (a.stream.type === b.stream.type ? 0 : a.stream.type === 'video' ? -1 : 1));
    picks.forEach((p, i) => {
      const s = Object.assign({}, p.stream, { index: i });
      this.streams.push(s);
      this.routes[p.input].set(p.stream.index, i);
    });
    if (!this.streams.length) throw badArg('no streams selected');
    this.timeOf = this.streams.map((s) => s.timeScale || 1);
  }

  async peek(k) {
    if (this.pending[k] || this.finished[k]) return this.pending[k];
    for (;;) {
      const pkt = await this.demuxers[k].readPacket();
      if (!pkt) {
        this.finished[k] = true;
        return null;
      }
      const out = this.routes[k].get(pkt.stream);
      if (out === undefined) continue;
      pkt.stream = out;
      this.pending[k] = pkt;
      return pkt;
    }
  }

  async readPacket() {
    let best = -1;
    let bestTime = Infinity;
    for (let k = 0; k < this.demuxers.length; k++) {
      if (!this.routes[k].size) continue;
      const p = await this.peek(k);
      if (!p) {
        if (this.shortest) return null;
        continue;
      }
      const t = p.dts / this.timeOf[p.stream];
      if (t < bestTime) {
        bestTime = t;
        best = k;
      }
    }
    if (best < 0) return null;
    const pkt = this.pending[best];
    this.pending[best] = null;
    return pkt;
  }

  async close() {
    for (const d of this.demuxers) {
      try {
        await d.close();
      } catch (ignored) {
        d.closed = true;
      }
    }
  }
}

export { MergedDemuxer };
