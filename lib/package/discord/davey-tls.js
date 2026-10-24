export class Writer {
  constructor() {
    this.chunks = []
  }

  u8(value) {
    this.chunks.push(Buffer.from([value & 0xff]))
    return this
  }

  u16(value) {
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(value)
    this.chunks.push(buf)
    return this
  }

  u32(value) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(value >>> 0)
    this.chunks.push(buf)
    return this
  }

  u64(value) {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(value))
    this.chunks.push(buf)
    return this
  }

  varint(value) {
    if (value < 0x40) return this.u8(value)
    if (value < 0x4000) return this.u16(0x4000 | value)
    if (value < 0x40000000) return this.u32((0x80000000 | value) >>> 0)
    throw new RangeError('varint out of range')
  }

  raw(buf) {
    this.chunks.push(Buffer.from(buf))
    return this
  }

  vec(buf) {
    this.varint(buf.length)
    return this.raw(buf)
  }

  list(items, encode) {
    const inner = new Writer()
    for (const item of items) encode(inner, item)
    return this.vec(inner.finish())
  }

  finish() {
    return Buffer.concat(this.chunks)
  }
}

export class Reader {
  constructor(buf) {
    this.buf = Buffer.from(buf)
    this.pos = 0
  }

  get done() {
    return this.pos >= this.buf.length
  }

  need(n) {
    if (this.pos + n > this.buf.length) throw new RangeError('truncated TLS input')
  }

  u8() {
    this.need(1)
    return this.buf[this.pos++]
  }

  u16() {
    this.need(2)
    const value = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return value
  }

  u32() {
    this.need(4)
    const value = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return value
  }

  u64() {
    this.need(8)
    const value = this.buf.readBigUInt64BE(this.pos)
    this.pos += 8
    return value
  }

  varint() {
    this.need(1)
    const prefix = this.buf[this.pos] >> 6
    if (prefix === 0) return this.u8()
    if (prefix === 1) return this.u16() & 0x3fff
    if (prefix === 2) return this.u32() & 0x3fffffff
    throw new RangeError('invalid varint prefix')
  }

  bytes(n) {
    this.need(n)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  vec() {
    return this.bytes(this.varint())
  }

  sub() {
    return new Reader(this.vec())
  }

  list(decode) {
    const reader = this.sub()
    const items = []
    while (!reader.done) items.push(decode(reader))
    return items
  }

  rest() {
    return this.bytes(this.buf.length - this.pos)
  }

  expectDone() {
    if (!this.done) throw new RangeError('trailing TLS bytes')
  }
}
