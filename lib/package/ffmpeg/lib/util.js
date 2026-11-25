class Vec {
  constructor(Type, capacity = 256) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }

  push(value) {
    if (this.length === this.data.length) {
      const next = new this.Type(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }

  get(index) {
    return this.data[index];
  }

  set(index, value) {
    this.data[index] = value;
  }

  view() {
    return this.data.subarray(0, this.length);
  }
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function fourcc(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function writeFourcc(buf, off, str) {
  for (let i = 0; i < 4; i++) buf[off + i] = str.charCodeAt(i) & 0xff;
}

function readU64BE(buf, off) {
  return buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
}

function writeU64BE(buf, off, value) {
  buf.writeUInt32BE(Math.floor(value / 4294967296), off);
  buf.writeUInt32BE(value >>> 0, off + 4);
}

function readU64LE(buf, off) {
  return buf.readUInt32LE(off + 4) * 4294967296 + buf.readUInt32LE(off);
}

function writeU64LE(buf, off, value) {
  buf.writeUInt32LE(value >>> 0, off);
  buf.writeUInt32LE(Math.floor(value / 4294967296), off + 4);
}

function equalBuffers(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.equals(b);
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return parseFloat(text);
  const parts = text.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p)) || parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return total;
}

function parseGain(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  const db = /^(-?\d+(\.\d+)?)\s*dB$/i.exec(text);
  if (db) return Math.pow(10, parseFloat(db[1]) / 20);
  return parseFloat(text);
}

export {
  Vec,
  gcd,
  fourcc,
  writeFourcc,
  readU64BE,
  writeU64BE,
  readU64LE,
  writeU64LE,
  equalBuffers,
  parseTime,
  parseGain,
};
