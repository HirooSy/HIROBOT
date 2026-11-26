import fs from 'node:fs';
import { badData } from './errors.js';

const emptyBuf = Buffer.alloc(0);

class FileSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  static async open(path) {
    const handle = await fs.promises.open(path, 'r');
    const stat = await handle.stat();
    return new FileSource(handle, stat.size);
  }

  async readInto(buf, off, len, pos) {
    const result = await this.handle.read(buf, off, len, pos);
    return result.bytesRead;
  }

  async close() {
    await this.handle.close();
  }
}

class BufferSource {
  constructor(buf) {
    this.buf = buf;
    this.size = buf.length;
  }

  async readInto(buf, off, len, pos) {
    if (pos >= this.size) return 0;
    const n = Math.min(len, this.size - pos);
    this.buf.copy(buf, off, pos, pos + n);
    return n;
  }

  async close() {}
}

class Reader {
  constructor(source, windowSize = 262144) {
    this.source = source;
    this.size = source.size;
    this.window = Buffer.allocUnsafe(Math.min(windowSize, Math.max(4096, source.size)));
    this.winStart = 0;
    this.winLen = 0;
    this.pos = 0;
  }

  get eof() {
    return this.pos >= this.size;
  }

  get remaining() {
    return this.size - this.pos;
  }

  seek(pos) {
    this.pos = pos;
  }

  skip(n) {
    this.pos += n;
  }

  async fill(pos) {
    const want = Math.min(this.window.length, this.size - pos);
    let got = 0;
    while (got < want) {
      const n = await this.source.readInto(this.window, got, want - got, pos + got);
      if (n <= 0) break;
      got += n;
    }
    this.winStart = pos;
    this.winLen = got;
  }

  async readInto(dst, off, want) {
    want = Math.min(want, this.size - this.pos);
    let done = 0;
    while (done < want) {
      const p = this.pos + done;
      if (p >= this.winStart && p < this.winStart + this.winLen) {
        const k = Math.min(want - done, this.winStart + this.winLen - p);
        this.window.copy(dst, off + done, p - this.winStart, p - this.winStart + k);
        done += k;
      } else if (want - done >= this.window.length) {
        const got = await this.source.readInto(dst, off + done, want - done, p);
        if (got <= 0) break;
        done += got;
      } else {
        await this.fill(p);
        if (this.winLen === 0) break;
      }
    }
    this.pos += done;
    return done;
  }

  async read(n) {
    n = Math.min(n, this.size - this.pos);
    if (n <= 0) return emptyBuf;
    const out = Buffer.allocUnsafe(n);
    const got = await this.readInto(out, 0, n);
    return got === n ? out : out.subarray(0, got);
  }

  async readExact(n) {
    const buf = await this.read(n);
    if (buf.length < n) throw badData('unexpected end of file');
    return buf;
  }

  async peek(n) {
    const p = this.pos;
    const buf = await this.read(n);
    this.pos = p;
    return buf;
  }

  async u8() {
    return (await this.readExact(1))[0];
  }

  async u16be() {
    return (await this.readExact(2)).readUInt16BE(0);
  }

  async u16le() {
    return (await this.readExact(2)).readUInt16LE(0);
  }

  async u32be() {
    return (await this.readExact(4)).readUInt32BE(0);
  }

  async u32le() {
    return (await this.readExact(4)).readUInt32LE(0);
  }

  async close() {
    await this.source.close();
  }
}

class FileSink {
  constructor(handle, bufSize) {
    this.handle = handle;
    this.buf = Buffer.allocUnsafe(bufSize);
    this.len = 0;
    this.flushed = 0;
    this.maxEnd = 0;
  }

  static async open(path, bufSize = 262144) {
    const handle = await fs.promises.open(path, 'w+');
    return new FileSink(handle, bufSize);
  }

  get pos() {
    return this.flushed + this.len;
  }

  get length() {
    return Math.max(this.maxEnd, this.pos);
  }

  async rawWrite(data, pos) {
    if (pos + data.length > this.maxEnd) this.maxEnd = pos + data.length;
    let off = 0;
    while (off < data.length) {
      const result = await this.handle.write(data, off, data.length - off, pos + off);
      off += result.bytesWritten;
    }
  }

  async write(data) {
    if (data.length >= this.buf.length) {
      await this.flush();
      await this.rawWrite(data, this.flushed);
      this.flushed += data.length;
      return;
    }
    if (this.len + data.length > this.buf.length) await this.flush();
    data.copy(this.buf, this.len);
    this.len += data.length;
  }

  async flush() {
    if (this.len > 0) {
      await this.rawWrite(this.buf.subarray(0, this.len), this.flushed);
      this.flushed += this.len;
      this.len = 0;
    }
  }

  async writeAt(pos, data) {
    await this.flush();
    await this.rawWrite(data, pos);
  }

  async readAt(buf, off, len, pos) {
    await this.flush();
    const result = await this.handle.read(buf, off, len, pos);
    return result.bytesRead;
  }

  async truncate(length) {
    await this.flush();
    await this.handle.truncate(length);
    this.flushed = length;
  }

  async close() {
    await this.flush();
    await this.handle.close();
  }
}

class BufferSink {
  constructor(capacity = 65536) {
    this.buf = Buffer.allocUnsafe(Math.max(65536, capacity));
    this.len = 0;
  }

  get pos() {
    return this.len;
  }

  get length() {
    return this.len;
  }

  async write(data) {
    const need = this.len + data.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = Buffer.allocUnsafe(cap);
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    data.copy(this.buf, this.len);
    this.len += data.length;
  }

  async flush() {}

  async writeAt(pos, data) {
    const need = pos + data.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = Buffer.allocUnsafe(cap);
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    data.copy(this.buf, pos);
    if (need > this.len) this.len = need;
  }

  async readAt(buf, off, len, pos) {
    const n = Math.max(0, Math.min(len, this.len - pos));
    this.buf.copy(buf, off, pos, pos + n);
    return n;
  }

  async truncate(length) {
    this.len = length;
  }

  async close() {}

  result() {
    if (this.buf.length - this.len > Math.max(1048576, Math.floor(this.len / 8))) return Buffer.from(this.buf.subarray(0, this.len));
    return this.buf.subarray(0, this.len);
  }
}

async function openReader(input, windowSize) {
  if (Buffer.isBuffer(input)) return new Reader(new BufferSource(input), windowSize);
  if (input instanceof Uint8Array) return new Reader(new BufferSource(Buffer.from(input.buffer, input.byteOffset, input.byteLength)), windowSize);
  return new Reader(await FileSource.open(input), windowSize);
}

export {
  FileSource,
  BufferSource,
  Reader,
  FileSink,
  BufferSink,
  openReader,
  emptyBuf,
};
