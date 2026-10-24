import { EventEmitter } from 'node:events'
import { createWebSocket } from './websocket.js'

const FATAL = {
  4004: ['TokenInvalid', 'An invalid token was provided.'],
  4010: ['InvalidShard', 'Invalid shard.'],
  4011: ['ShardingRequired', 'Sharding is required.'],
  4012: ['InvalidAPIVersion', 'Invalid API version.'],
  4013: ['InvalidIntents', 'Invalid intents were provided.'],
  4014: ['DisallowedIntents', 'Used disallowed intents.']
}
const NO_RESUME = [4007, 4009]
const jitter = ms => Math.floor(Math.random() * ms)

export class Gateway extends EventEmitter {
  constructor(rest, token, intents, presence = null) {
    super()
    this.rest = rest
    this.token = token
    this.intents = intents
    this.presence = presence
    this.ws = null
    this.gatewayUrl = null
    this.sessionId = null
    this.resumeUrl = null
    this.seq = null
    this.acked = true
    this.hbSentAt = 0
    this.ping = -1
    this.hbFirst = null
    this.hbTimer = null
    this.reconnectTimer = null
    this.closed = false
  }

  async connect() {
    this.closed = false
    const info = await this.rest.get('/gateway/bot')
    this.gatewayUrl = `${info.url}/?v=10&encoding=json`
    this.open(this.gatewayUrl)
  }

  open(url) {
    const ws = createWebSocket(url)
    this.ws = ws
    ws.onmessage = event => this.onMessage(ws, event.data)
    ws.onclose = event => this.onClose(ws, event.code)
    ws.onerror = () => {}
  }

  onMessage(ws, raw) {
    if (ws !== this.ws) return
    let packet
    try {
      packet = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof packet.s === 'number') this.seq = packet.s
    if (packet.op === 0) this.onDispatch(packet.t, packet.d)
    else if (packet.op === 1) this.send(1, this.seq)
    else if (packet.op === 7) this.restart(true)
    else if (packet.op === 9) this.restart(packet.d === true)
    else if (packet.op === 10) {
      this.startHeartbeat(packet.d.heartbeat_interval)
      if (this.sessionId && this.resumeUrl) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq })
      else this.identify()
    } else if (packet.op === 11) {
      this.acked = true
      this.ping = Date.now() - this.hbSentAt
    }
  }

  onDispatch(type, data) {
    if (type === 'READY') {
      this.sessionId = data.session_id
      this.resumeUrl = data.resume_gateway_url
    }
    this.emit('dispatch', type, data)
  }

  identify() {
    this.send(2, {
      token: this.token,
      intents: this.intents,
      properties: { os: process.platform, browser: 'hiro', device: 'hiro' },
      ...(this.presence ? { presence: this.presence } : {})
    })
  }

  updatePresence(presence) {
    this.presence = presence
    this.send(3, presence)
  }

  onClose(ws, code) {
    if (ws !== this.ws || this.closed) return
    this.stopHeartbeat()
    this.ws = null
    if (FATAL[code]) {
      this.closed = true
      const err = new Error(FATAL[code][1])
      err.code = FATAL[code][0]
      err.closeCode = code
      this.emit('fatal', err)
      return
    }
    this.restart(!NO_RESUME.includes(code))
  }

  restart(resume) {
    this.stopHeartbeat()
    const old = this.ws
    this.ws = null
    try {
      old?.close(4000)
    } catch {}
    if (!resume || !this.sessionId) {
      this.sessionId = null
      this.resumeUrl = null
      this.seq = null
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return
      this.open(this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : this.gatewayUrl)
    }, 1000 + jitter(2000))
  }

  startHeartbeat(ms) {
    this.stopHeartbeat()
    this.acked = true
    this.hbFirst = setTimeout(() => {
      this.beat()
      this.hbTimer = setInterval(() => this.beat(), ms)
    }, jitter(ms))
  }

  beat() {
    if (!this.acked) {
      this.restart(true)
      return
    }
    this.acked = false
    this.hbSentAt = Date.now()
    this.send(1, this.seq)
  }

  stopHeartbeat() {
    clearTimeout(this.hbFirst)
    clearInterval(this.hbTimer)
    this.hbFirst = null
    this.hbTimer = null
  }

  send(op, d) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d }))
  }

  close() {
    this.closed = true
    this.stopHeartbeat()
    clearTimeout(this.reconnectTimer)
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000)
    } catch {}
  }
}
