const SEQ_MOD = 0x10000;
const HALF = 0x8000;

function seqDelta(a, b) {
    const d = (b - a) & 0xffff;
    return d >= HALF ? d - SEQ_MOD : d;
}

export class AudioReorderBuffer {
    #next = -1;
    #pending = new Map();
    #window;
    #maxConcealRun;
    #resyncDistance;
    stats = { duplicates: 0, late: 0, concealed: 0, resyncs: 0, delivered: 0 };

    constructor({ window = 3, maxConcealRun = 5, resyncDistance = 250 } = {}) {
        this.#window = window;
        this.#maxConcealRun = maxConcealRun;
        this.#resyncDistance = resyncDistance;
    }

    reset() {
        this.#next = -1;
        this.#pending.clear();
    }

    push(seq, payload) {
        const out = [];
        if (this.#next < 0) {
            this.#next = seq;
        }
        const d = seqDelta(this.#next, seq);
        if (d < 0) {
            if (d < -this.#resyncDistance) {
                this.#resync(seq);
            } else {
                this.stats.late++;
                return out;
            }
        } else if (d > this.#resyncDistance) {
            this.#resync(seq);
        }
        if (this.#pending.has(seq)) {
            this.stats.duplicates++;
            return out;
        }
        this.#pending.set(seq, payload);
        this.#drain(out, false);
        return out;
    }

    flush() {
        const out = [];
        this.#drain(out, true);
        return out;
    }

    #resync(seq) {
        this.stats.resyncs++;
        this.#pending.clear();
        this.#next = seq;
    }

    #drain(out, force) {
        for (;;) {
            if (this.#pending.has(this.#next)) {
                out.push(this.#pending.get(this.#next));
                this.#pending.delete(this.#next);
                this.#next = (this.#next + 1) & 0xffff;
                this.stats.delivered++;
                continue;
            }
            if (this.#pending.size === 0) {
                return;
            }
            const farthest = this.#farthestAhead();
            if (!force && farthest < this.#window) {
                return;
            }
            const hole = Math.min(this.#maxConcealRun, this.#holeLength());
            for (let i = 0; i < hole; i++) {
                out.push(null);
                this.stats.concealed++;
            }
            this.#next = (this.#next + this.#holeLength()) & 0xffff;
        }
    }

    #farthestAhead() {
        let max = 0;
        for (const s of this.#pending.keys()) {
            const d = seqDelta(this.#next, s);
            if (d > max) max = d;
        }
        return max;
    }

    #holeLength() {
        let min = Infinity;
        for (const s of this.#pending.keys()) {
            const d = seqDelta(this.#next, s);
            if (d >= 0 && d < min) min = d;
        }
        return min === Infinity ? 0 : min;
    }
}
