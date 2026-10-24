import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export function createWebSocket(url) {
  if (typeof globalThis.WebSocket === 'function') {
    const ws = new globalThis.WebSocket(url)
    ws.binaryType = 'arraybuffer'
    return ws
  }
  return new NodeWebSocket(url)
}

class NodeWebSocket {
  constructor(url) {
    const target = new URL(url)
    this.url = url
    this.readyState = CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.buffer = Buffer.alloc(0)
    this.handshaked = false
    this.fragments = []
    this.fragOp = 0
    this.finished = false
    const secure = target.protocol === 'wss:'
    const port = Number(target.port) || (secure ? 443 : 80)
    const key = randomBytes(16).toString('base64')
    this.expectedAccept = createHash('sha1').update(key + GUID).digest('base64')
    this.socket = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname })
      : net.connect({ host: target.hostname, port })
    const path = `${target.pathname || '/'}${target.search}`
    const host = target.port ? `${target.hostname}:${target.port}` : target.hostname
    this.socket.write(
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    )
    this.socket.on('data', chunk => this.onData(chunk))
    this.socket.on('error', err => this.fail(err))
    this.socket.on('close', () => this.finish(1006, ''))
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    if (!this.handshaked) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const lines = this.buffer.subarray(0, end).toString('latin1').split('\r\n')
      this.buffer = this.buffer.subarray(end + 4)
      let accept = null
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':')
        if (at > 0 && line.slice(0, at).trim().toLowerCase() === 'sec-websocket-accept') accept = line.slice(at + 1).trim()
      }
      if (!/^HTTP\/1\.1 101/.test(lines[0]) || accept !== this.expectedAccept) {
        this.fail(new Error(`WebSocket handshake failed: ${lines[0]}`))
        return
      }
      this.handshaked = true
      this.readyState = OPEN
      this.onopen?.({})
    }
    this.parseFrames()
  }

  parseFrames() {
    while (this.buffer.length >= 2 && !this.finished) {
      const fin = (this.buffer[0] & 0x80) !== 0
      const opcode = this.buffer[0] & 0x0f
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.buffer.length < offset + length) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)
      this.handleFrame(fin, opcode, payload)
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode >= 8) {
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        this.sendFrame(8, payload.subarray(0, 2))
        this.readyState = CLOSING
        this.socket.end()
        this.finish(code, reason)
      } else if (opcode === 9) {
        this.sendFrame(10, payload)
      }
      return
    }
    if (opcode !== 0) {
      this.fragOp = opcode
      this.fragments = []
    }
    this.fragments.push(payload)
    if (!fin) return
    const data = Buffer.concat(this.fragments)
    this.fragments = []
    if (this.fragOp === 1) this.onmessage?.({ data: data.toString('utf8') })
    else if (this.fragOp === 2) this.onmessage?.({ data })
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.finished || !this.socket || this.socket.destroyed) return
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(2)
      header[1] = 0x80 | len
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    const mask = randomBytes(4)
    const masked = Buffer.alloc(len)
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  send(data) {
    if (this.readyState !== OPEN) return
    if (data instanceof Uint8Array) this.sendFrame(2, Buffer.from(data))
    else this.sendFrame(1, Buffer.from(String(data), 'utf8'))
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    if (this.readyState === OPEN) {
      this.readyState = CLOSING
      const text = Buffer.from(reason, 'utf8')
      const body = Buffer.alloc(2 + text.length)
      body.writeUInt16BE(code, 0)
      text.copy(body, 2)
      this.sendFrame(8, body)
      this.socket.end()
      setTimeout(() => this.socket.destroy(), 1000).unref()
      this.finish(code, reason)
    } else {
      this.socket.destroy()
      this.finish(code, reason)
    }
  }

  fail(err) {
    if (this.finished) return
    this.onerror?.({ error: err, message: err?.message })
    this.socket.destroy()
    this.finish(1006, '')
  }

  finish(code, reason) {
    if (this.finished) return
    this.finished = true
    this.readyState = CLOSED
    this.onclose?.({ code, reason })
  }
}
