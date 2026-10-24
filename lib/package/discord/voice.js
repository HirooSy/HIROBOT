import dgram from 'node:dgram'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { createWebSocket } from './websocket.js'
import { encryptRtp, pickMode, SILENCE_FRAME } from './crypto.js'
import { openOpus } from './opus.js'
import { DaveController } from './davey-controller.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const LEAD_MS = 1000
const PREROLL_FRAMES = 25
const PACER_BOOT_MS = 6000
const MAX_RECOVERIES = 5
const RECOVER_DELAY_MS = 1000
const RECOVER_TIMEOUT_MS = 20000
const FATAL_CLOSE_CODES = [4001, 4002, 4003, 4004, 4005, 4011, 4012, 4014, 4016]

class PacerCore {
  constructor(dgram, post) {
    this.dgram = dgram
    this.post = post
    this.socket = null
    this.ip = null
    this.port = 0
    this.queue = []
    this.timer = null
    this.probeTimer = null
    this.next = 0
    this.held = false
    this.keepAliveTimer = null
    this.keepAliveCounter = 0
  }

  open({ ip, port, probe }) {
    this.ip = ip
    this.port = port
    const data = Buffer.from(probe)
    const socket = this.dgram.createSocket('udp4')
    this.socket = socket
    socket.on('error', err => {
      this.post({ t: 'error', message: String((err && err.message) || err) })
    })
    socket.once('message', reply => {
      this.stopProbing()
      this.post({ t: 'discovered', data: Uint8Array.from(reply) })
    })
    let attempts = 0
    const probeOnce = () => {
      if (attempts >= 20) {
        this.stopProbing()
        this.post({ t: 'error', message: 'No reply to UDP discovery from the voice server ' + ip + ':' + port + ' (UDP to this port may be blocked by the host or network)' })
        return
      }
      attempts++
      try {
        socket.send(data, port, ip)
      } catch (err) {
        this.stopProbing()
        this.post({ t: 'error', message: String((err && err.message) || err) })
      }
    }
    probeOnce()
    this.probeTimer = setInterval(probeOnce, 250)
    this.keepAliveCounter = 0
    this.keepAliveTimer = setInterval(() => {
      const beat = Buffer.alloc(8)
      beat.writeUInt32LE(this.keepAliveCounter, 0)
      this.keepAliveCounter = (this.keepAliveCounter + 1) >>> 0
      try {
        socket.send(beat, port, ip)
      } catch {}
    }, 5000)
    this.keepAliveTimer.unref?.()
  }

  stopProbing() {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  enqueue(data) {
    this.queue.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    if (!this.timer && !this.held) this.pump()
  }

  pump() {
    this.timer = null
    if (!this.socket || this.held || !this.queue.length) return
    const now = performance.now()
    if (this.next === 0 || this.next < now - 60) this.next = now
    let sent = 0
    while (this.queue.length && this.next <= now + 1 && sent < 3) {
      this.socket.send(this.queue.shift(), this.port, this.ip)
      this.next += 20
      sent++
    }
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), Math.max(0, this.next - performance.now() - 1))
  }

  handle(msg) {
    if (msg.t === 'open') {
      this.open(msg)
    } else if (msg.t === 'packet') {
      this.enqueue(msg.data)
    } else if (msg.t === 'flush') {
      this.clearTimer()
      this.queue = []
      this.next = 0
      this.held = false
    } else if (msg.t === 'hold') {
      this.clearTimer()
      this.held = true
    } else if (msg.t === 'resume') {
      this.held = false
      this.next = 0
      if (this.queue.length) this.pump()
    } else if (msg.t === 'close') {
      this.clearTimer()
      this.stopProbing()
      clearInterval(this.keepAliveTimer)
      try {
        if (this.socket) this.socket.close()
      } catch {}
      this.post({ t: 'closed' })
    }
  }
}

const PACER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const dgram = require('node:dgram')
${PacerCore.toString()}
const core = new PacerCore(dgram, msg => {
  parentPort.postMessage(msg)
  if (msg.t === 'closed') process.exit(0)
})
parentPort.on('message', msg => core.handle(msg))
parentPort.postMessage({ t: 'ready' })
`

class UdpPacer extends EventEmitter {
  constructor(ip, port, probe) {
    super()
    this.args = { ip, port, probe: Uint8Array.from(probe) }
    this.worker = null
    this.inline = null
    this.booted = false
    this.discovered = false
    this.closed = false
    this.watchdog = null
    this.startWorker()
  }

  startWorker() {
    let worker
    try {
      worker = new Worker(PACER_SOURCE, { eval: true })
    } catch (err) {
      this.fallback(err.message)
      return
    }
    this.worker = worker
    worker.unref()
    worker.on('message', msg => this.onCore(msg))
    worker.on('error', err => this.fallback(err.message))
    worker.on('exit', () => this.fallback('worker exited'))
    this.watchdog = setTimeout(() => {
      if (!this.booted) this.fallback('worker did not start in time')
    }, PACER_BOOT_MS)
    this.watchdog.unref()
    worker.postMessage({ t: 'open', ...this.args })
  }

  onCore(msg) {
    if (msg.t === 'ready') {
      this.booted = true
      clearTimeout(this.watchdog)
    } else if (msg.t === 'discovered') {
      this.discovered = true
      this.emit('discovered', Buffer.from(msg.data))
    } else if (msg.t === 'error') {
      this.emit('error', new Error(msg.message))
    }
  }

  dropWorker() {
    clearTimeout(this.watchdog)
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.removeAllListeners()
    worker.on('error', () => {})
    worker.terminate().catch(() => {})
  }

  fallback(reason) {
    if (this.closed || this.inline) return
    this.dropWorker()
    if (this.discovered) {
      this.emit('error', new Error(`UDP sender stopped: ${reason}`))
      return
    }
    console.warn(`[voice] pacing on the main thread because the worker is unavailable: ${reason}`)
    this.inline = new PacerCore(dgram, msg => this.onCore(msg))
    this.inline.handle({ t: 'open', ...this.args })
  }

  post(msg, transfer) {
    if (this.inline) this.inline.handle(msg)
    else this.worker?.postMessage(msg, transfer)
  }

  send(packet) {
    if (this.closed) return
    const data = Uint8Array.from(packet)
    this.post({ t: 'packet', data }, [data.buffer])
  }

  flush() {
    this.post({ t: 'flush' })
  }

  hold() {
    this.post({ t: 'hold' })
  }

  resume() {
    this.post({ t: 'resume' })
  }

  close() {
    if (this.closed) return
    this.post({ t: 'close' })
    this.closed = true
    clearTimeout(this.watchdog)
    this.worker = null
    this.inline = null
  }
}

export class VoiceError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'VoiceError'
    this.code = code ?? null
  }
}

export class VoiceManager {
  constructor(client) {
    this.client = client
    this.connections = new Map()
  }

  get(guildId) {
    return this.connections.get(guildId) ?? null
  }

  async join({ guildId, channelId, selfDeaf = true, timeout = 20000 }) {
    this.leave(guildId)
    const connection = new VoiceConnection(this.client, guildId, channelId)
    this.connections.set(guildId, connection)
    try {
      await connection.start(selfDeaf, timeout)
    } catch (err) {
      connection.destroy()
      throw err
    }
    return connection
  }

  leave(guildId) {
    this.connections.get(guildId)?.destroy()
  }

  onVoiceState(d) {
    if (d.user_id !== this.client.user?.id) return
    this.connections.get(d.guild_id)?.onState(d)
  }

  onVoiceServer(d) {
    this.connections.get(d.guild_id)?.onServer(d)
  }

  destroyAll() {
    for (const id of [...this.connections.keys()]) this.leave(id)
  }
}

export class VoiceConnection extends EventEmitter {
  constructor(client, guildId, channelId, { createSocket = createWebSocket } = {}) {
    super()
    this.client = client
    this.guildId = guildId
    this.channelId = channelId
    this.createSocket = createSocket
    this.selfDeaf = true
    this.wasReady = false
    this.recoveries = 0
    this.recoverTimer = null
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.ws = null
    this.udp = null
    this.hb = null
    this.hbSentAt = 0
    this.missedHeartbeats = 0
    this.wsSeq = -1
    this.ssrc = 0
    this.ip = null
    this.port = 0
    this.mode = null
    this.key = null
    this.seq = Math.floor(Math.random() * 0xffff)
    this.ts = Math.floor(Math.random() * 0xffffffff) >>> 0
    this.nonce = 0
    this.encryptedFrames = 0
    this.plainFrames = 0
    this.droppedFrames = 0
    this.ready = false
    this.destroyed = false
    this.error = null
    this.stage = 'idle'
    this.wsError = null
    this.dave = this.createDave()
    this.player = new VoicePlayer(this)
  }

  createDave() {
    return new DaveController({
      userId: this.client.user?.id,
      channelId: this.channelId,
      sendJson: packet => this.sendPacket(packet),
      sendBinary: (op, payload) => this.sendBinaryPacket(op, payload)
    })
  }

  async start(selfDeaf, timeout) {
    this.selfDeaf = selfDeaf
    this.stage = 'waiting for the gateway to send voice server info'
    this.sendGateway({ guild_id: this.guildId, channel_id: this.channelId, self_mute: false, self_deaf: selfDeaf })
    await this.until(() => this.sessionId && this.endpoint && this.token, timeout, 'voice server info')
    this.open(false)
    await this.until(() => this.ready, timeout, () => `voice handshake (stuck at: ${this.stage}${this.wsError ? `; websocket error: ${this.wsError}` : ''})`)
  }

  async until(test, timeout, what) {
    const end = Date.now() + timeout
    while (!test()) {
      if (this.destroyed) throw new VoiceError(this.error?.message || 'Voice connection was closed', this.error?.code)
      if (Date.now() > end) throw new VoiceError(`Timed out waiting for ${typeof what === 'function' ? what() : what}`)
      await sleep(50)
    }
  }

  sendGateway(d) {
    this.client.gateway?.send(4, d)
  }

  onState(d) {
    if (this.destroyed) return
    if (!d.channel_id) {
      if (this.ready) this.destroy()
      return
    }
    this.channelId = d.channel_id
    this.sessionId = d.session_id
  }

  onServer(d) {
    if (this.destroyed || !d.endpoint) return
    const moved = this.wasReady && this.ready && !!this.endpoint && d.endpoint !== this.endpoint
    this.token = d.token
    this.endpoint = d.endpoint
    if (moved) this.reidentify()
  }

  open(resume = false) {
    const previous = this.ws
    this.ws = null
    clearInterval(this.hb)
    this.hb = null
    try {
      previous?.close(1000)
    } catch {}
    this.stage = resume ? 'resuming the voice websocket' : 'connecting to the voice websocket'
    const ws = this.createSocket(`wss://${this.endpoint}/?v=8`)
    this.ws = ws
    ws.onopen = () => {
      if (resume) {
        this.stage = 'waiting for voice Resumed (op 9)'
        this.sendWs(7, { server_id: this.guildId, session_id: this.sessionId, token: this.token, seq_ack: this.wsSeq })
        return
      }
      this.stage = 'waiting for voice Ready (op 2)'
      this.sendWs(0, {
        server_id: this.guildId,
        user_id: this.client.user.id,
        session_id: this.sessionId,
        token: this.token,
        max_dave_protocol_version: this.dave.maxProtocolVersion
      })
    }
    ws.onmessage = event => this.onWsMessage(ws, event.data)
    ws.onclose = event => this.onWsClose(ws, event.code)
    ws.onerror = event => {
      this.wsError = event?.error?.message || event?.message || 'connection error'
    }
  }

  onWsMessage(ws, raw) {
    if (ws !== this.ws || this.destroyed) return
    if (typeof raw !== 'string') {
      this.onBinaryMessage(Buffer.from(raw))
      return
    }
    let packet
    try {
      packet = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof packet.seq === 'number') this.wsSeq = packet.seq
    if (packet.op === 8) this.startHeartbeat(packet.d.heartbeat_interval)
    else if (packet.op === 2) this.onReadyPacket(packet.d)
    else if (packet.op === 4) this.onSession(packet.d)
    else if (packet.op === 6) this.missedHeartbeats = 0
    else if (packet.op === 9) this.onResumed()
    else if (packet.op === 11) this.dave.clientsConnect(packet.d.user_ids)
    else if (packet.op === 13) this.dave.clientDisconnect(packet.d.user_id)
    else if (packet.op === 21) this.dave.prepareTransition(packet.d)
    else if (packet.op === 22) this.dave.executeTransition(packet.d.transition_id)
    else if (packet.op === 24) this.dave.prepareEpoch(packet.d)
  }

  onBinaryMessage(buffer) {
    if (buffer.length < 3) return
    this.wsSeq = buffer.readUInt16BE(0)
    const op = buffer.readUInt8(2)
    const payload = buffer.subarray(3)
    try {
      if (op === 25) this.dave.setExternalSender(payload)
      else if (op === 27) this.dave.processProposals(payload)
      else if (op === 29) this.dave.announceCommit(payload)
      else if (op === 30) this.dave.welcome(payload)
    } catch {}
  }

  onReadyPacket(d) {
    this.ssrc = d.ssrc
    this.ip = d.ip
    this.port = d.port
    this.mode = pickMode(d.modes)
    if (!this.mode) {
      this.fail(new VoiceError('Discord did not offer a supported voice encryption mode'))
      return
    }
    this.stage = 'waiting for the UDP discovery reply'
    this.discover()
  }

  discover() {
    this.udp?.close()
    const probe = Buffer.alloc(74)
    probe.writeUInt16BE(1, 0)
    probe.writeUInt16BE(70, 2)
    probe.writeUInt32BE(this.ssrc, 4)
    const udp = new UdpPacer(this.ip, this.port, probe)
    this.udp = udp
    udp.on('error', err => this.fail(err))
    udp.once('discovered', message => {
      if (this.destroyed || udp !== this.udp) return
      const address = message.subarray(8, 72).toString('utf8').replace(/\0[\s\S]*$/, '')
      const port = message.readUInt16BE(72)
      this.stage = 'waiting for the session description (op 4)'
      this.sendWs(1, { protocol: 'udp', data: { address, port, mode: this.mode } })
    })
  }

  onSession(d) {
    this.key = Buffer.from(d.secret_key)
    this.mode = d.mode || this.mode
    this.dave.sessionDescription(d.dave_protocol_version ?? 0)
    this.stage = 'ready'
    this.ready = true
    this.wasReady = true
    this.recoveries = 0
    this.emit('ready')
    if (this.player?.playing && !this.player.paused) this.setSpeaking(true)
  }

  onResumed() {
    this.stage = 'ready'
    this.recoveries = 0
  }

  clearRecover() {
    if (this.recoverTimer) clearTimeout(this.recoverTimer)
    this.recoverTimer = null
  }

  recover(code) {
    if (this.destroyed || !this.wasReady || FATAL_CLOSE_CODES.includes(code) || this.recoveries >= MAX_RECOVERIES) return false
    this.recoveries += 1
    this.clearRecover()
    const resume = (code === 4015 || code < 4000) && !!this.sessionId && !!this.endpoint && !!this.token
    this.stage = resume ? 'waiting to resume the voice connection' : 'waiting to rejoin the voice channel'
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null
      if (this.destroyed) return
      if (resume) this.open(true)
      else this.rejoin()
    }, RECOVER_DELAY_MS * this.recoveries)
    return true
  }

  async rejoin() {
    this.ready = false
    this.key = null
    this.udp?.close()
    this.udp = null
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.sendGateway({ guild_id: this.guildId, channel_id: this.channelId, self_mute: false, self_deaf: this.selfDeaf })
    try {
      await this.until(() => this.sessionId && this.endpoint && this.token, RECOVER_TIMEOUT_MS, 'voice server info')
    } catch (err) {
      this.fail(err)
      return
    }
    this.reidentify()
  }

  reidentify() {
    this.clearRecover()
    this.ready = false
    this.key = null
    this.udp?.close()
    this.udp = null
    this.dave.destroy()
    this.dave = this.createDave()
    this.open(false)
  }

  startHeartbeat(ms) {
    clearInterval(this.hb)
    this.missedHeartbeats = 0
    this.hb = setInterval(() => {
      if (this.destroyed) return
      if (this.missedHeartbeats >= 3) {
        try {
          this.ws?.close(1000)
        } catch {}
        return
      }
      this.missedHeartbeats += 1
      this.hbSentAt = Date.now()
      this.sendWs(3, { t: Date.now(), seq_ack: this.wsSeq })
    }, Math.floor(ms))
  }

  onWsClose(ws, code) {
    if (ws !== this.ws || this.destroyed) return
    this.ws = null
    clearInterval(this.hb)
    this.hb = null
    if (this.recover(code)) return
    this.fail(new VoiceError(code === 4017 ? 'Voice gateway rejected the DAVE session (code 4017)' : `Voice connection closed (code ${code ?? '-'}${this.wsError ? `: ${this.wsError}` : ''}; stage: ${this.stage})`, code))
  }

  fail(err) {
    if (this.destroyed) return
    this.error = err
    this.destroy()
  }

  sendWs(op, d) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d }))
  }

  sendPacket(packet) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(packet))
  }

  sendBinaryPacket(op, payload) {
    if (this.ws?.readyState === 1) this.ws.send(Buffer.concat([Buffer.from([op]), payload]))
  }

  channelBitrate() {
    const guild = this.client?.guilds?.cache?.get?.(this.guildId)
    const channel = guild?.channels?.cache?.get?.(this.channelId) ?? this.client?.channels?.get?.(this.channelId)
    return channel?.bitrate ?? null
  }

  setSpeaking(on) {
    this.sendWs(5, { speaking: on ? 1 : 0, delay: 0, ssrc: this.ssrc })
  }

  sendOpus(frame) {
    if (!this.ready || !this.udp || !this.key) {
      this.droppedFrames += 1
      return
    }
    const header = Buffer.alloc(12)
    header[0] = 0x80
    header[1] = 0x78
    header.writeUInt16BE(this.seq, 2)
    header.writeUInt32BE(this.ts, 4)
    header.writeUInt32BE(this.ssrc, 8)
    let payload
    try {
      payload = this.dave.encryptOpus(frame)
    } catch {
      this.droppedFrames += 1
      return
    }
    if (payload === frame) this.plainFrames += 1
    else this.encryptedFrames += 1
    const packet = encryptRtp(this.mode, this.key, header, payload, this.nonce)
    this.udp.send(packet)
    this.seq = (this.seq + 1) & 0xffff
    this.ts = (this.ts + 960) >>> 0
    this.nonce = (this.nonce + 1) >>> 0
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.clearRecover()
    this.player.halt()
    this.dave.destroy()
    clearInterval(this.hb)
    this.hb = null
    if (this.channelId) this.sendGateway({ guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false })
    const ws = this.ws
    const udp = this.udp
    this.ws = null
    this.udp = null
    try {
      ws?.close(1000)
    } catch {}
    try {
      udp?.close()
    } catch {}
    if (this.client.voice.connections.get(this.guildId) === this) this.client.voice.connections.delete(this.guildId)
    this.emit('destroyed')
  }
}

export class VoicePlayer extends EventEmitter {
  constructor(connection) {
    super()
    this.connection = connection
    this.input = null
    this.volume = 1
    this.source = null
    this.token = 0
    this.base = 0
    this.frames = 0
    this.t0 = 0
    this.paused = false
    this.pausedAt = 0
    this.wake = null
    this.userAgent = null
  }

  get playing() {
    return this.source !== null
  }

  get position() {
    const clock = this.paused ? this.pausedAt : Date.now()
    return this.base + Math.max(0, Math.min(this.frames * 20, clock - this.t0))
  }

  play(input, { volume, seek = 0, userAgent = null } = {}) {
    this.halt()
    this.input = input
    this.userAgent = userAgent
    if (volume !== undefined) this.volume = volume
    this.launch(seek)
  }

  launch(seekMs) {
    const token = this.token
    this.base = seekMs
    this.frames = 0
    this.paused = false
    const source = openOpus(this.input, { volume: this.volume, seekMs, userAgent: this.userAgent, bitrate: this.connection.channelBitrate() })
    this.source = source
    this.run(source, token)
  }

  async run(source, token) {
    this.connection.setSpeaking(true)
    this.t0 = Date.now()
    let failure = null
    const preroll = []
    let primed = false
    const deliver = async packet => {
      while (this.paused && token === this.token) {
        await new Promise(resolve => {
          this.wake = resolve
        })
      }
      if (token !== this.token) return false
      this.connection.sendOpus(packet)
      this.frames += 1
      const now = Date.now()
      if (now > this.t0 + this.frames * 20 + 40) this.t0 = now - this.frames * 20
      const wait = this.t0 + this.frames * 20 - LEAD_MS - Date.now()
      if (wait > 0) await sleep(wait)
      return token === this.token
    }
    try {
      for await (const packet of source.packets) {
        if (!primed) {
          preroll.push(packet)
          if (preroll.length < PREROLL_FRAMES) continue
          primed = true
          for (const queued of preroll.splice(0)) if (!(await deliver(queued))) break
          continue
        }
        if (!(await deliver(packet))) break
      }
      if (!primed && token === this.token) {
        for (const queued of preroll.splice(0)) if (!(await deliver(queued))) break
      }
      if (token === this.token) {
        const tail = this.t0 + this.frames * 20 - Date.now()
        if (tail > 0) await sleep(tail)
      }
    } catch (err) {
      failure = err
    }
    if (token !== this.token) return
    source.kill()
    this.source = null
    this.connection.setSpeaking(false)
    this.sendSilence()
    if (failure && this.listenerCount('error')) this.emit('error', failure)
    this.emit('idle')
  }

  sendSilence() {
    for (let i = 0; i < 5; i++) this.connection.sendOpus(SILENCE_FRAME)
  }

  halt() {
    this.token += 1
    this.paused = false
    this.connection.udp?.flush?.()
    const wake = this.wake
    this.wake = null
    wake?.()
    const source = this.source
    this.source = null
    source?.kill()
  }

  stop() {
    const was = this.playing
    this.halt()
    if (was) {
      this.connection.setSpeaking(false)
      this.sendSilence()
      this.emit('idle')
    }
  }

  pause() {
    if (!this.playing || this.paused) return false
    this.paused = true
    this.pausedAt = Date.now()
    this.connection.udp?.hold?.()
    this.connection.setSpeaking(false)
    return true
  }

  unpause() {
    if (!this.paused) return false
    this.paused = false
    this.t0 += Date.now() - this.pausedAt
    this.connection.udp?.resume?.()
    this.connection.setSpeaking(true)
    const wake = this.wake
    this.wake = null
    wake?.()
    return true
  }

  setVolume(volume) {
    this.volume = volume
    if (!this.playing) return
    const at = this.position
    const wasPaused = this.paused
    this.halt()
    this.launch(at)
    if (wasPaused) this.pause()
  }
}
