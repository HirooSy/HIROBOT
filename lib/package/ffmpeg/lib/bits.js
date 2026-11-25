import { badData } from './errors.js';

class BitReader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start * 8;
    this.limit = end * 8;
  }

  read(n) {
    if (n === 0) return 0;
    if (n > 24) {
      const hi = this.read(n - 16);
      return hi * 65536 + this.read(16);
    }
    const p = this.pos;
    const next = p + n;
    if (next > this.limit) throw badData('bitstream overrun');
    const i = p >>> 3;
    const b = this.buf;
    const w = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    this.pos = next;
    return (w << (p & 7)) >>> (32 - n);
  }

  peek(n) {
    const p = this.pos;
    const i = p >>> 3;
    const b = this.buf;
    const w = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    return (w << (p & 7)) >>> (32 - n);
  }

  signed(n) {
    if (n === 0) return 0;
    if (n > 24) {
      const v = this.read(n);
      return v >= Math.pow(2, n - 1) ? v - Math.pow(2, n) : v;
    }
    return (this.read(n) << (32 - n)) >> (32 - n);
  }

  unary() {
    let n = 0;
    const b = this.buf;
    for (;;) {
      const i = this.pos >>> 3;
      if (i >= b.length || this.pos >= this.limit) throw badData('bitstream overrun');
      const off = this.pos & 7;
      const v = (b[i] << off) & 0xff;
      if (v) {
        const z = Math.clz32(v) - 24;
        this.pos += z + 1;
        return n + z;
      }
      n += 8 - off;
      this.pos = (i + 1) << 3;
    }
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  get bytePos() {
    return this.pos >>> 3;
  }
}

const pow2 = [];
for (let i = 0; i <= 40; i++) pow2.push(Math.pow(2, i));

class BitWriter {
  constructor(size = 65536) {
    this.buf = Buffer.allocUnsafe(size);
    this.pos = 0;
    this.acc = 0;
    this.bits = 0;
  }

  reset() {
    this.pos = 0;
    this.acc = 0;
    this.bits = 0;
  }

  ensure(extra) {
    if (this.pos + extra > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.pos + extra) cap *= 2;
      const next = Buffer.allocUnsafe(cap);
      this.buf.copy(next, 0, 0, this.pos);
      this.buf = next;
    }
  }

  write(value, n) {
    if (n === 0) return;
    if (value < 0) value += pow2[n];
    if (n > 16) {
      this.write(Math.floor(value / 65536), n - 16);
      this.write(value % 65536, 16);
      return;
    }
    this.ensure(4);
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.buf[this.pos++] = (this.acc >>> this.bits) & 0xff;
    }
    this.acc &= (1 << this.bits) - 1;
  }

  unary(q) {
    while (q >= 16) {
      this.write(0, 16);
      q -= 16;
    }
    this.write(1, q + 1);
  }

  rice(value, k) {
    const u = value >= 0 ? value * 2 : -value * 2 - 1;
    const q = u >>> k;
    const low = u & ((1 << k) - 1);
    if (q + k + 1 <= 31) this.write((1 << k) | low, q + k + 1);
    else {
      this.unary(q);
      if (k > 0) this.write(low, k);
    }
  }

  align() {
    if (this.bits > 0) this.write(0, 8 - this.bits);
  }

  get byteLength() {
    return this.pos;
  }

  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

export {
  BitReader,
  BitWriter,
};
