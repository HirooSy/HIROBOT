import path from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { EventEmitter } from 'events'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { lookup as dnsLookup } from 'dns/promises'
import { isIP } from 'net'
import db, { loadDatabase } from '../../utils/database.js'
import chalk from '../../utils/color.js'
import axios from 'axios'

// ==================== minimal WebSocket server (replaces the 'ws' package) ====================
// RFC 6455 implementation on node:http + node:crypto. Covers only what this file
// needs: new WebSocketServer({ server }), wss.on('connection', (ws, req) => ...),
// wss.clients, and per-socket on('message'|'close'|'error') / send() / readyState.
const _WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const _WS_OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

function _wsAcceptKeyFor(clientKey) {
    return createHash('sha1').update(clientKey + _WS_MAGIC).digest('base64')
}

function _wsEncodeFrame(opcode, payload) {
    const payloadLen = payload.length
    let header
    if (payloadLen < 126) {
        header = Buffer.alloc(2)
        header[1] = payloadLen
    } else if (payloadLen < 65536) {
        header = Buffer.alloc(4)
        header[1] = 126
        header.writeUInt16BE(payloadLen, 2)
    } else {
        header = Buffer.alloc(10)
        header[1] = 127
        header.writeBigUInt64BE(BigInt(payloadLen), 2)
    }
    header[0] = 0x80 | opcode // FIN=1, no RSV bits
    return Buffer.concat([header, payload])
}

class WebSocketConnection extends EventEmitter {
    constructor(socket) {
        super()
        this.socket = socket
        this.readyState = WebSocketConnection.OPEN
        this._recvBuffer = Buffer.alloc(0)
        this._fragments = []

        socket.on('data', chunk => this._onData(chunk))
        socket.on('close', () => this._onSocketClose())
        socket.on('error', err => this.emit('error', err))
    }

    _onSocketClose() {
        if (this.readyState === WebSocketConnection.CLOSED) return
        this.readyState = WebSocketConnection.CLOSED
        this.emit('close')
    }

    _onData(chunk) {
        this._recvBuffer = this._recvBuffer.length ? Buffer.concat([this._recvBuffer, chunk]) : chunk
        while (true) {
            const frame = this._tryParseFrame(this._recvBuffer)
            if (!frame) break
            this._recvBuffer = this._recvBuffer.subarray(frame.totalLength)
            this._handleFrame(frame)
        }
    }

    _tryParseFrame(buf) {
        if (buf.length < 2) return null
        const fin = (buf[0] & 0x80) !== 0
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let payloadLen = buf[1] & 0x7f
        let offset = 2

        if (payloadLen === 126) {
            if (buf.length < offset + 2) return null
            payloadLen = buf.readUInt16BE(offset)
            offset += 2
        } else if (payloadLen === 127) {
            if (buf.length < offset + 8) return null
            payloadLen = Number(buf.readBigUInt64BE(offset))
            offset += 8
        }

        let maskKey
        if (masked) {
            if (buf.length < offset + 4) return null
            maskKey = buf.subarray(offset, offset + 4)
            offset += 4
        }

        if (buf.length < offset + payloadLen) return null

        let payload = buf.subarray(offset, offset + payloadLen)
        if (masked) {
            const unmasked = Buffer.alloc(payloadLen)
            for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4]
            payload = unmasked
        }

        return { fin, opcode, payload: Buffer.from(payload), totalLength: offset + payloadLen }
    }

    _handleFrame(frame) {
        switch (frame.opcode) {
            case _WS_OPCODE.CONTINUATION:
            case _WS_OPCODE.TEXT:
            case _WS_OPCODE.BINARY: {
                this._fragments.push(frame.payload)
                if (frame.fin) {
                    const full = Buffer.concat(this._fragments)
                    this._fragments = []
                    this.emit('message', full)
                }
                break
            }
            case _WS_OPCODE.CLOSE:
                this._sendClose()
                this.socket.end()
                break
            case _WS_OPCODE.PING:
                this._writeRaw(_wsEncodeFrame(_WS_OPCODE.PONG, frame.payload))
                break
            case _WS_OPCODE.PONG:
                break
        }
    }

    _writeRaw(buf) {
        if (!this.socket.destroyed) this.socket.write(buf)
    }

    send(data) {
        if (this.readyState !== WebSocketConnection.OPEN) return
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
        this._writeRaw(_wsEncodeFrame(_WS_OPCODE.TEXT, payload))
    }

    _sendClose() {
        if (this.readyState === WebSocketConnection.CLOSED) return
        this.readyState = WebSocketConnection.CLOSED
        this._writeRaw(_wsEncodeFrame(_WS_OPCODE.CLOSE, Buffer.alloc(0)))
    }

    close() {
        this._sendClose()
        this.socket.end()
    }
}
WebSocketConnection.CONNECTING = 0
WebSocketConnection.OPEN = 1
WebSocketConnection.CLOSING = 2
WebSocketConnection.CLOSED = 3
Object.defineProperties(WebSocketConnection.prototype, {
    OPEN: { value: WebSocketConnection.OPEN },
    CONNECTING: { value: WebSocketConnection.CONNECTING },
    CLOSING: { value: WebSocketConnection.CLOSING },
    CLOSED: { value: WebSocketConnection.CLOSED }
})

class WebSocketServer extends EventEmitter {
    constructor(opts) {
        super()
        this.clients = new Set()
        if (opts?.server) this.attach(opts.server)
    }

    attach(httpServer) {
        httpServer.on('upgrade', (req, socket, head) => {
            if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
                socket.destroy()
                return
            }
            const clientKey = req.headers['sec-websocket-key']
            if (!clientKey) {
                socket.destroy()
                return
            }
            const acceptKey = _wsAcceptKeyFor(clientKey)
            const responseHeaders = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey}`, '', '']
            socket.write(responseHeaders.join('\r\n'))

            const ws = new WebSocketConnection(socket)
            this.clients.add(ws)
            ws.once('close', () => this.clients.delete(ws))
            if (head?.length) ws._onData(head)

            this.emit('connection', ws, req)
        })
    }
}

const scryptAsync = promisify(scrypt)

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const VIEWS_DIR  = path.join(__dirname, 'views')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'upload')
const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const UPLOAD_MAX_BODY_BYTES = 100 * 1024 * 1024

const UPLOAD_MIME_TYPES = {
  ...MIME_TYPES,
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mkv':  'video/x-matroska',
  '.mov':  'video/quicktime',
  '.3gp':  'video/3gpp',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav':  'audio/wav',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
  '.txt':  'text/plain; charset=utf-8',
}

function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })
}

async function cleanupOldUploads() {
  try {
    ensureUploadDir()
    const files = await readdir(UPLOAD_DIR)
    const now = Date.now()
    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, file)
      try {
        const st = await stat(filePath)
        if (now - st.mtimeMs > UPLOAD_MAX_AGE_MS) {
          await unlink(filePath)
          console.log(chalk.gray(`[UPLOAD] Expired file removed: ${file}`))
        }
      } catch (_) { }
    }
  } catch (err) {
    console.error('[UPLOAD CLEANUP]', err.message)
  }
}

ensureUploadDir()
cleanupOldUploads()
setInterval(cleanupOldUploads, 60 * 60 * 1000).unref()

function randomUploadName(ext) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(7)
  let name = ''
  for (let i = 0; i < 7; i++) name += chars[bytes[i] % chars.length]
  return ext ? `${name}.${ext}` : name
}

function extFromPart(part) {
  if (part.filename) {
    const ext = path.extname(part.filename).replace('.', '').toLowerCase()
    if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext
  }
  const CT_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'application/zip': 'zip',
  }
  if (part.contentType && CT_EXT[part.contentType.split(';')[0].trim()]) {
    return CT_EXT[part.contentType.split(';')[0].trim()]
  }
  return 'bin'
}

function readRawBody(req, limitBytes = UPLOAD_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('Payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseMultipart(buffer, boundary) {
  const parts = []
  const boundaryBuf = Buffer.from(`--${boundary}`)
  let start = buffer.indexOf(boundaryBuf)
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length)
    if (next === -1) break
    let part = buffer.slice(start + boundaryBuf.length, next)
    if (part.slice(0, 2).toString('latin1') === '\r\n') part = part.slice(2)
    if (part.slice(-2).toString('latin1') === '\r\n') part = part.slice(0, -2)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8')
      const body = part.slice(headerEnd + 4)
      const nameMatch = headerStr.match(/name="([^"]*)"/i)
      const filenameMatch = headerStr.match(/filename="([^"]*)"/i)
      const typeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i)
      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: typeMatch ? typeMatch[1].trim() : null,
        data: body,
      })
    }
    start = next
  }
  return parts
}

function buildUploadUrl(req, filename) {
  const configuredHost = (process.env.HOSTNAME_PUBLIC || process.env.CLOUDFLARE_TUNNEL_HOSTNAME || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
  if (configuredHost) return `https://${configuredHost}/files/${filename}`

  const host = req.headers['x-forwarded-host'] || req.headers.host
  const proto = req.headers['x-forwarded-proto'] || (host && host.includes('trycloudflare.com') ? 'https' : 'http')
  return `${proto}://${host}/files/${filename}`
}

async function serveUploadedFile(res, rawName) {
  let name
  try { name = path.basename(decodeURIComponent(rawName)) } catch (_) { name = path.basename(rawName) }
  if (!name || name.includes('..')) return false
  const filePath = path.join(UPLOAD_DIR, name)
  if (!filePath.startsWith(UPLOAD_DIR) || !existsSync(filePath)) return false
  try {
    const content = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': UPLOAD_MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=604800',
    })
    res.end(content)
    return true
  } catch (_) {
    return false
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(password, salt, 64)
  return `${salt}:${derived.toString('hex')}`
}

async function verifyPassword(password, stored) {
  if (!stored) return false
  const parts = stored.split(':')
  if (parts.length !== 2 || parts[1].length !== 128) {
    const a = Buffer.from(password)
    const b = Buffer.from(stored)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }
  const [salt, hashHex] = parts
  const derived = await scryptAsync(password, salt, 64)
  const hashBuf = Buffer.from(hashHex, 'hex')
  if (derived.length !== hashBuf.length) return false
  return timingSafeEqual(derived, hashBuf)
}

const _attempts = new Map()

function checkMemoryRateLimit(key, opts) {
  const { windowMs, max, blockMs } = opts
  const now = Date.now()
  let rec = _attempts.get(key)

  if (rec && rec.blockedUntil && now < rec.blockedUntil) {
    const waitSec = Math.ceil((rec.blockedUntil - now) / 1000)
    return `Too many attempts. Try again in ${waitSec}s.`
  }

  if (!rec || now - rec.firstAt > windowMs) {
    rec = { count: 0, firstAt: now, blockedUntil: 0 }
  }

  rec.count++
  if (rec.count > max) {
    rec.blockedUntil = now + blockMs
    _attempts.set(key, rec)
    const waitSec = Math.ceil(blockMs / 1000)
    return `Too many attempts. Try again in ${waitSec}s.`
  }

  _attempts.set(key, rec)
  return null
}

setInterval(() => {
  const now = Date.now()
  for (const [key, rec] of _attempts) {
    if (now - rec.firstAt > 60 * 60 * 1000 && (!rec.blockedUntil || now > rec.blockedUntil)) {
      _attempts.delete(key)
    }
  }
}, 10 * 60 * 1000).unref()

const DB_LIMIT_WINDOW_MS = 10 * 60 * 1000
const DB_LIMIT_MAX = 5
const DB_LIMIT_BLOCK_MS = 15 * 60 * 1000

function ensureBruteforceStore() {
  if (!db.data.bruteforce) db.data.bruteforce = {}
}

async function checkDbRateLimit(key, opts = {}) {
  const { windowMs = DB_LIMIT_WINDOW_MS, max = DB_LIMIT_MAX, blockMs = DB_LIMIT_BLOCK_MS } = opts
  await ensureDB()
  ensureBruteforceStore()

  const now = Date.now()
  let rec = db.data.bruteforce[key]

  if (rec && rec.blockedUntil && now < rec.blockedUntil) {
    const waitSec = Math.ceil((rec.blockedUntil - now) / 1000)
    return `Too many attempts. Try again in ${waitSec}s.`
  }

  if (!rec || now - rec.firstAt > windowMs) {
    rec = { count: 0, firstAt: now, blockedUntil: 0 }
  }

  rec.count++
  if (rec.count > max) {
    rec.blockedUntil = now + blockMs
    db.data.bruteforce[key] = rec
    await db.write()
    const waitSec = Math.ceil(blockMs / 1000)
    return `Too many attempts. Try again in ${waitSec}s.`
  }

  db.data.bruteforce[key] = rec
  await db.write()
  return null
}

async function clearDbRateLimit(key) {
  await ensureDB()
  ensureBruteforceStore()
  if (db.data.bruteforce[key]) {
    delete db.data.bruteforce[key]
    await db.write()
  }
}

setInterval(async () => {
  try {
    await ensureDB()
    ensureBruteforceStore()
    const now = Date.now()
    let changed = false
    for (const [key, rec] of Object.entries(db.data.bruteforce)) {
      const windowExpired = now - rec.firstAt > DB_LIMIT_WINDOW_MS
      const blockExpired = !rec.blockedUntil || now > rec.blockedUntil
      if (windowExpired && blockExpired) {
        delete db.data.bruteforce[key]
        changed = true
      }
    }
    if (changed) await db.write()
  } catch (err) {
    console.error('[bruteforce cleanup]', err)
  }
}, 15 * 60 * 1000).unref()

const _pendingOtp = new Map()

const _pendingHtmlActions = new Map()
const HTML_ACTION_TTL_MS = 15 * 60 * 1000

function registerHtmlAction({ chatId, run, singleUse = true }, ttlMs = HTML_ACTION_TTL_MS) {
  if (typeof run !== 'function') {
    throw new TypeError('registerHtmlAction requires a `run` function')
  }
  const token = randomBytes(16).toString('hex')
  _pendingHtmlActions.set(token, { chatId, run, singleUse, expiresAt: Date.now() + ttlMs })
  return token
}

// Lets an htmlAction's run() push messages out to every websocket client
// currently subscribed to a given channel, instead of only replying to the
// single client that made the request. A channel here is just an arbitrary
// string a plugin picks (e.g. a live-chat token) - clients join it by
// sending {type:'subscribe', channel}. Used for the .verifyme test below,
// but generic enough for any future plugin wanting a simple broadcast.
const _wsChannels = new Map()

function subscribeWs(ws, channel) {
  if (!_wsChannels.has(channel)) _wsChannels.set(channel, new Set())
  _wsChannels.get(channel).add(ws)
}

function unsubscribeWsFromAll(ws) {
  for (const set of _wsChannels.values()) set.delete(ws)
}

function broadcastToChannel(channel, payload, exceptWs = null) {
  const set = _wsChannels.get(channel)
  if (!set) return
  const data = JSON.stringify(payload)
  for (const ws of set) {
    if (ws === exceptWs) continue
    if (ws.readyState === ws.OPEN) ws.send(data)
  }
}

global.broadcastToChannel = broadcastToChannel

setInterval(() => {
  const now = Date.now()
  for (const [token, rec] of _pendingHtmlActions) {
    if (now > rec.expiresAt) _pendingHtmlActions.delete(token)
  }
}, 5 * 60 * 1000).unref()

async function performHtmlAction(conn, token, args = {}) {
  const rec = _pendingHtmlActions.get(token)
  if (!rec) return { success: false, message: 'This action has expired or was already used.' }

  if (Date.now() > rec.expiresAt) {
    _pendingHtmlActions.delete(token)
    return { success: false, message: 'This action has expired.' }
  }

  if (rec.singleUse) _pendingHtmlActions.delete(token)

  try {
    const result = await rec.run(conn, rec.chatId, args)
    if (result && typeof result === 'object') return { success: true, ...result }
    return { success: true, message: 'Done.' }
  } catch (err) {
    console.error('[htmlAction]', err.message)
    return { success: false, message: err.message || 'Action failed.' }
  }
}

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_COOLDOWN_MS = 60 * 1000

function generateOtpCode() {
  return String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')
}

async function sendOtp(conn, targetKey, purpose) {
  const existing = _pendingOtp.get(targetKey)
  if (existing && Date.now() - (existing.sentAt || 0) < OTP_RESEND_COOLDOWN_MS) {
    return { ok: false, message: 'Please wait before requesting another code.' }
  }

  const code = generateOtpCode()
  const pendingToken = generateToken(targetKey)
  _pendingOtp.set(targetKey, {
    code, purpose,
    expiresAt: Date.now() + OTP_TTL_MS,
    sentAt: Date.now(),
    attempts: 0,
    pendingToken
  })

  const displayName = db.data.users?.[targetKey]?.name || normalizePhone(targetKey)
  const otpMessage = {
    text: `Hi ${displayName}. Here's your ${purpose === 'register' ? 'registration' : 'login'} code, don't give this code to anyone.\n\nCode expires in 5 minutes.`,
    nativeFlow: [{ text: 'COPY CODE', copy: code }]
  }

  const isTransient428 = (err) => {
    const statusCode = err?.output?.statusCode ?? err?.data?.output?.statusCode
    return statusCode === 428 || err?.message === 'Connection Closed'
  }

  const MAX_ATTEMPTS = 3
  const RETRY_DELAYS_MS = [1000, 2000]

  if (conn.isSocketReady === false) {
    const waitStart = Date.now()
    while (conn.isSocketReady === false && Date.now() - waitStart < 8000) {
      await new Promise(r => setTimeout(r, 250))
    }
  }

  let lastErr = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await conn.sendButton(targetKey, otpMessage)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1
      if (!isLastAttempt && isTransient428(err)) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 2000
        console.warn(`[OTP SEND] transient error (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      break
    }
  }

  if (lastErr) {
    console.error('[OTP SEND]', lastErr)
    _pendingOtp.delete(targetKey)
    return { ok: false, message: 'Failed to send code. Make sure the number is registered on WhatsApp.' }
  }

  return { ok: true, pendingToken }
}

function verifyOtp(targetKey, pendingToken, code) {
  const rec = _pendingOtp.get(targetKey)
  if (!rec) return { ok: false, message: 'No pending code for this number. Please request a new one.' }
  if (rec.pendingToken !== pendingToken) return { ok: false, message: 'Invalid session. Please request a new code.' }
  if (Date.now() > rec.expiresAt) {
    _pendingOtp.delete(targetKey)
    return { ok: false, message: 'Code expired. Please request a new one.' }
  }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    _pendingOtp.delete(targetKey)
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' }
  }

  rec.attempts++
  if (rec.code !== String(code).trim()) {
    return { ok: false, message: `Incorrect code. ${OTP_MAX_ATTEMPTS - rec.attempts} attempt(s) left.` }
  }

  _pendingOtp.delete(targetKey)
  return { ok: true, purpose: rec.purpose }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, rec] of _pendingOtp) {
    if (now > rec.expiresAt) _pendingOtp.delete(key)
  }
}, 60 * 1000).unref()

async function ensureDB() {
  if (db.data == null) await loadDatabase()
}

function pushNotification(user, message) {
  if (!Array.isArray(user.notification)) user.notification = []
  user.notification.push({ message, time: Date.now() })
  if (user.notification.length > 10) user.notification = user.notification.slice(-10)
}

async function sendWaNotif(conn, targetKey, message) {
  if (!conn || !targetKey) return
  try {
    if (typeof conn.sendMessage === 'function') {
      await conn.sendMessage(targetKey, { text: message })
    } else if (typeof conn.sendButton === 'function') {
      await conn.sendButton(targetKey, { text: message })
    }
  } catch (err) {
    console.error('[WA NOTIF]', err)
  }
}

function withTimeout(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ])
}

const BUY_LIMIT_PRICE = 1
const BUY_PREMIUM_PRICE = 100

function generateToken(phone) {
  return createHash('sha256').update(phone + Date.now() + randomBytes(8).toString('hex')).digest('hex')
}

function getToken(req) {
  const auth = req.headers['authorization']
  return auth ? auth.replace('Bearer ', '') : null
}

function getUserKeyFromToken(token) {
  return token ? db.data.sessions?.[token] : null
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return xff.split(',')[0].trim()
  return req.socket.remoteAddress
}

function ipSessionKey(req) {
  return `ip:${getClientIp(req)}`
}

function getUserKeyFromReq(req) {
  const byToken = getUserKeyFromToken(getToken(req))
  if (byToken) return byToken
  return db.data.sessions?.[ipSessionKey(req)] || null
}

function normalizePhone(raw) {
  return raw ? raw.replace(/@.*$/, '').trim() : ''
}

function checkOwner(token) {
  const userKey = getUserKeyFromToken(token)
  if (!userKey) return { userKey: null, isOwner: false }
  const phoneNumber = userKey.replace('@s.whatsapp.net', '')
  const isOwner = (global.settings.owner || []).some(o => o[0] === phoneNumber)
  return { userKey, isOwner }
}

function readJsonBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('Payload too large'))
        req.destroy()
        return
      }
      data.push(chunk)
    })
    req.on('end', () => {
      if (data.length === 0) return resolve({})
      try {
        const raw = Buffer.concat(data).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, obj) {
  if (res.headersSent) return
  const body = JSON.stringify(obj)
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${value}`]
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`)
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  parts.push('Path=/')
  const existing = res.getHeader('Set-Cookie')
  const cookieStr = parts.join('; ')
  if (existing) {
    res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr])
  } else {
    res.setHeader('Set-Cookie', cookieStr)
  }
}

async function serveStatic(req, res, urlPath) {

  let reqPath = urlPath === '/' ? '/index.html' : urlPath


  const candidates = []
  if (path.extname(reqPath)) {
    candidates.push(path.join(VIEWS_DIR, reqPath))
  } else {
    candidates.push(path.join(VIEWS_DIR, reqPath + '.html'))
    candidates.push(path.join(VIEWS_DIR, reqPath, 'index.html'))
  }

  for (const filePath of candidates) {

    if (!filePath.startsWith(VIEWS_DIR)) continue
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath)
        res.writeHead(200, { 'Content-Type': mimeFor(filePath) })
        res.end(content)
        return true
      } catch (e) {

      }
    }
  }
  return false
}

function buildRoutes(conn) {
  const routes = []

  const get = (p, h) => routes.push(['GET', p, h])
  const post = (p, h) => routes.push(['POST', p, h])

  get('/api/health', async (req, res) => {
    sendJson(res, 200, { ok: true, uptime: process.uptime() })
  })

  // Endpoint diagnostik: WAV 1 detik (440Hz) yang dibuat langsung oleh server, tanpa pihak ketiga.
  // Dipakai plugin .audiotest untuk memisahkan "WebView menolak <audio> dari server kita"
  // dari "link y2mate bermasalah". Mendukung Range seperti file media sungguhan.
  const TEST_WAV = (() => {
    const rate = 8000, n = rate, buf = Buffer.alloc(44 + n * 2)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 9000), 44 + i * 2)
    return buf
  })()

  get('/api/audiotest.wav', async (req, res) => {
    const base = {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers['range'] || '')
    if (range) {
      let start = range[1] === '' ? 0 : parseInt(range[1], 10)
      let end = range[2] === '' ? TEST_WAV.length - 1 : Math.min(parseInt(range[2], 10), TEST_WAV.length - 1)
      if (start > end || start >= TEST_WAV.length) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${TEST_WAV.length}` })
        return res.end()
      }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${TEST_WAV.length}`, 'Content-Length': end - start + 1 })
      return res.end(TEST_WAV.subarray(start, end + 1))
    }
    res.writeHead(200, { ...base, 'Content-Length': TEST_WAV.length })
    res.end(TEST_WAV)
  })

  function isPrivateIp(ip) {
    const type = isIP(ip)
    if (type === 4) {
      const [a, b] = ip.split('.').map(Number)
      if (a === 10 || a === 127 || a === 0) return true
      if (a === 169 && b === 254) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
      if (a === 100 && b >= 64 && b <= 127) return true
      return false
    }
    if (type === 6) {
      const lower = ip.toLowerCase()
      if (lower === '::1') return true
      if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true
      if (lower.startsWith('::ffff:')) {
        const v4 = lower.split(':').pop()
        if (isIP(v4) === 4) return isPrivateIp(v4)
      }
      return false
    }
    return true
  }

  // Cache hasil cek DNS per-hostname. Tanpa ini setiap gambar/thumbnail yang lewat
  // /api/proxy memicu DNS lookup baru, padahal satu galeri bisa memuat 50 gambar
  // dari host yang sama (i.pinimg.com, static1.e621.net, dll).
  const SAFE_HOST_CACHE = new Map()
  const SAFE_HOST_TTL = 5 * 60 * 1000

  async function isSafeProxyTarget(hostname) {
    if (isIP(hostname)) return !isPrivateIp(hostname)
    const cached = SAFE_HOST_CACHE.get(hostname)
    if (cached && Date.now() < cached.expiresAt) return cached.safe
    let safe = false
    try {
      const results = await dnsLookup(hostname, { all: true, verbatim: true })
      safe = results.length > 0 && results.every(r => !isPrivateIp(r.address))
    } catch {
      return false // jangan cache kegagalan DNS
    }
    SAFE_HOST_CACHE.set(hostname, { safe, expiresAt: Date.now() + SAFE_HOST_TTL })
    return safe
  }

  function refererFor(targetUrl) {
    const host = targetUrl.hostname
    if (host.endsWith('dzcdn.net')) return 'https://www.deezer.com/'
    return `${targetUrl.protocol}//${targetUrl.host}/`
  }

  // ── /api/proxy ────────────────────────────────────────────────────────────
  // Cache kecil di memori untuk gambar/thumbnail (bukan audio/video). Tanpa ini
  // tiap slide yang dibuka ulang harus fetch ke CDN lagi dari VPS.
  const PROXY_CACHE = new Map()
  const PROXY_CACHE_MAX_ITEMS = 120
  const PROXY_CACHE_MAX_BYTES = 6 * 1024 * 1024
  const PROXY_CACHE_TTL = 15 * 60 * 1000

  function proxyCacheGet(key) {
    const hit = PROXY_CACHE.get(key)
    if (!hit) return null
    if (Date.now() > hit.expiresAt) { PROXY_CACHE.delete(key); return null }
    PROXY_CACHE.delete(key); PROXY_CACHE.set(key, hit) // refresh urutan (LRU)
    return hit
  }
  function proxyCacheSet(key, entry) {
    PROXY_CACHE.set(key, { ...entry, expiresAt: Date.now() + PROXY_CACHE_TTL })
    while (PROXY_CACHE.size > PROXY_CACHE_MAX_ITEMS) PROXY_CACHE.delete(PROXY_CACHE.keys().next().value)
  }

  // Tebak mime dari ekstensi/URL, dipakai kalau upstream mengirim tipe generik
  // (octet-stream) — <audio>/<img> di WebView menolak tipe seperti itu.
  function guessMime(url, upstreamType) {
    const t = (upstreamType || '').split(';')[0].trim().toLowerCase()
    if (t && t !== 'application/octet-stream' && t !== 'binary/octet-stream' && t !== 'text/plain') return t
    const u = url.toLowerCase().split('?')[0]
    if (/\.mp3$/.test(u)) return 'audio/mpeg'
    if (/\.(m4a|mp4a)$/.test(u)) return 'audio/mp4'
    if (/\.ogg$/.test(u)) return 'audio/ogg'
    if (/\.webm$/.test(u)) return 'video/webm'
    if (/\.mp4$/.test(u)) return 'video/mp4'
    if (/\.png$/.test(u)) return 'image/png'
    if (/\.gif$/.test(u)) return 'image/gif'
    if (/\.webp$/.test(u)) return 'image/webp'
    if (/\.jpe?g$/.test(u)) return 'image/jpeg'
    if (/[?&]f=mp3\b/.test(url.toLowerCase())) return 'audio/mpeg' // link y2mate: ...&f=mp3
    return t || 'application/octet-stream'
  }

  get('/api/proxy', async (req, res) => {
    // Header CORS/CORP supaya <img>/<audio> dari origin WebView lain boleh memuat.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
    const fail = (code, message) => {
      if (res.headersSent) return
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders })
      res.end(JSON.stringify({ success: false, message }))
    }

    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`)
      const target = urlObj.searchParams.get('url')
      if (!target) return fail(400, 'Missing url')

      let targetUrl
      try { targetUrl = new URL(target) } catch { return fail(400, 'Invalid url') }
      if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') return fail(400, 'Invalid protocol')

      const safe = await isSafeProxyTarget(targetUrl.hostname)
      if (!safe) return fail(403, 'Host not allowed')

      const rangeHeader = req.headers['range']
      const cacheKey = targetUrl.toString()

      // Cache hanya untuk request tanpa Range (gambar/thumbnail).
      if (!rangeHeader) {
        const cached = proxyCacheGet(cacheKey)
        if (cached) {
          res.writeHead(200, {
            'Content-Type': cached.contentType,
            'Content-Length': cached.body.length,
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders
          })
          return res.end(cached.body)
        }
      }

      const refOverride = urlObj.searchParams.get('ref')
      const forwardHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': refOverride || refererFor(targetUrl)
      }
      if (rangeHeader) forwardHeaders['Range'] = rangeHeader

      // Timeout HANYA untuk menunggu respons awal. Sebelumnya AbortSignal.timeout(20000)
      // ikut memutus body stream di tengah jalan → audio terpotong / tidak bisa diputar.
      const controller = new AbortController()
      const connectTimer = setTimeout(() => controller.abort(), 25000)
      req.on('close', () => { if (!res.writableEnded) controller.abort() })

      const doFetch = (hdrs) => axios.get(targetUrl.toString(), {
        responseType: 'stream',
        signal: controller.signal,
        validateStatus: () => true,
        headers: hdrs,
        maxRedirects: 5
      })

      let upstream
      try {
        upstream = await doFetch(forwardHeaders)

        // Beberapa CDN (mis. y2mate/etacloud) menolak Referer/UA yang "aneh" dengan 401/403,
        // padahal request polos tanpa header tambahan (seperti tombol Download di bot) diterima.
        // Coba ulang bertahap: tanpa Referer -> tanpa Referer & UA bawaan Node.
        if (upstream.status === 401 || upstream.status === 403 || upstream.status === 400) {
          upstream.data.destroy?.()
          const noRef = { ...forwardHeaders }
          delete noRef['Referer']
          upstream = await doFetch(noRef)
          if (upstream.status === 401 || upstream.status === 403 || upstream.status === 400) {
            upstream.data.destroy?.()
            const bare = {}
            if (rangeHeader) bare['Range'] = rangeHeader
            upstream = await doFetch(bare)
          }
        }
      } catch (err) {
        clearTimeout(connectTimer)
        console.error('[proxy]', targetUrl.hostname, err.message)
        return fail(502, 'Upstream fetch failed')
      }
      clearTimeout(connectTimer)

      if (upstream.status >= 400) {
        console.error('[proxy]', targetUrl.hostname, 'upstream status', upstream.status)
        upstream.data.destroy?.()
        return fail(502, `Upstream ${upstream.status}`)
      }

      const contentType = guessMime(cacheKey, upstream.headers['content-type'])
      const isMedia = /^(audio|video)\//.test(contentType)
      const upstreamLen = Number(upstream.headers['content-length'] || 0)

      // Upstream HTML/JSON padahal diminta audio/video = halaman error, bukan file.
      if (/^(text\/html|application\/json)/.test(contentType) && /[?&]f=mp3\b|\.mp3|\.mp4|\.m4a/i.test(cacheKey)) {
        upstream.data.destroy?.()
        console.error('[proxy]', targetUrl.hostname, 'upstream returned', contentType, 'instead of media')
        return fail(502, 'Upstream returned non-media response')
      }

      // ── Gambar kecil: buffer + cache, kirim sekali ────────────────────────
      const cacheable = !rangeHeader && !isMedia && upstream.status === 200 && upstreamLen > 0 && upstreamLen <= PROXY_CACHE_MAX_BYTES
      if (cacheable) {
        const chunks = []
        try {
          for await (const chunk of upstream.data) chunks.push(chunk)
        } catch (err) {
          return fail(502, 'Upstream stream failed')
        }
        const body = Buffer.concat(chunks)
        proxyCacheSet(cacheKey, { body, contentType })
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': body.length,
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders
        })
        return res.end(body)
      }

      // ── Audio/video/besar: stream langsung, dukung Range dengan benar ──────
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders,
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      }
      const upstreamRanges = /bytes/i.test(upstream.headers['accept-ranges'] || '') || upstream.status === 206
      if (upstreamRanges) headers['Accept-Ranges'] = 'bytes'
      if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length']
      if (upstream.headers['content-range']) headers['Content-Range'] = upstream.headers['content-range']

      res.writeHead(upstream.status === 206 ? 206 : 200, headers)
      upstream.data.pipe(res)
      upstream.data.on('error', () => { if (!res.writableEnded) res.end() })
      res.on('close', () => upstream.data.destroy?.())
    } catch (err) {
      console.error('[proxy]', err.message)
      fail(500, 'Proxy error')
    }
  })

  post('/api/aiRich/action', async (req, res, ctx) => {
    try {
      const { token, ...args } = ctx.body || {}
      if (!token || typeof token !== 'string') {
        return sendJson(res, 400, { success: false, message: 'Missing token' })
      }
      const result = await performHtmlAction(conn, token, args)
      return sendJson(res, result.success ? 200 : 400, result)
    } catch (err) {
      console.error('[aiRich/action]', err.message)
      if (!res.headersSent) sendJson(res, 500, { success: false, message: 'Internal error' })
    }
  })

  post('/api/upload', async (req, res) => {
    try {
      ensureUploadDir()
      const contentType = req.headers['content-type'] || ''
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
      if (!contentType.toLowerCase().includes('multipart/form-data') || !boundaryMatch) {
        return sendJson(res, 400, { success: false, message: 'Send a multipart/form-data request with a file field.' })
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2]

      const raw = await readRawBody(req).catch(err => {
        sendJson(res, 413, { success: false, message: err.message })
        return null
      })
      if (raw === null) return

      const parts = parseMultipart(raw, boundary)
      const filePart = parts.find(p => p.filename && p.data && p.data.length > 0)
      if (!filePart) {
        return sendJson(res, 400, { success: false, message: 'No file found in the request body.' })
      }

      const ext = extFromPart(filePart)
      const name = randomUploadName(ext)
      await writeFile(path.join(UPLOAD_DIR, name), filePart.data)

      const url = buildUploadUrl(req, name)
      sendJson(res, 200, { success: true, url, filename: name, size: filePart.data.length, expiresIn: '7d' })
    } catch (err) {
      console.error('[UPLOAD]', err.message)
      if (!res.headersSent) sendJson(res, 500, { success: false, message: 'Upload failed: ' + err.message })
    }
  })

  get('/api/tierAsset', async (req, res) => {
    sendJson(res, 200, {
      name: global.settings.tier.name,
      exp: global.settings.tier.exp_required,
      limit: global.settings.tier.limit_capacity
    })
  })

  get('/api/botInfo', async (req, res) => {
    const botJid = conn?.user?.jid || conn?.user?.id || ''
    const botNumber = botJid ? botJid.split('@')[0].split(':')[0] : ''
    sendJson(res, 200, {
      name: global.settings.botname,
      icon: global.settings.icon,
      number: botNumber,
      uptime: process.uptime(),
      totalUsers: Object.keys(db.data.users || {}).length
    })
  })

  get('/api/commandList', async (req, res) => {
    try {
      const { plugins } = await import('../../utils/plugins.js')
      const commands = Object.values(plugins)
        .filter(plugin => !plugin.disabled && plugin.help)
        .flatMap(plugin => Array.isArray(plugin.help) ? plugin.help : [plugin.help])
        .map(h => h.split(' ')[0])
        .filter((h, i, arr) => arr.indexOf(h) === i)
        .sort()
      sendJson(res, 200, { total: commands.length, commands })
    } catch (e) {
      sendJson(res, 200, { total: 0, commands: [] })
    }
  })

  get('/api/envExample', async (req, res) => {
    try {
      const envPath = path.join(__dirname, '../../../.env.example')
      const content = await readFile(envPath, 'utf-8')
      sendJson(res, 200, { content })
    } catch (e) {
      sendJson(res, 200, { content: '' })
    }
  })


  post('/api/register', async (req, res, ctx) => {
    try {
      await ensureDB()
      const { phone, password } = ctx.body
      if (!phone || !password) return sendJson(res, 200, { success: false, message: 'Incomplete data.' })

      const normalizedPhone = normalizePhone(phone)
      const authBlock = await checkDbRateLimit(`auth:${normalizedPhone}`, { windowMs: DB_LIMIT_WINDOW_MS, max: DB_LIMIT_MAX, blockMs: DB_LIMIT_BLOCK_MS })
      if (authBlock) return sendJson(res, 429, { success: false, message: authBlock })

      if (password.length < 6) return sendJson(res, 200, { success: false, message: 'Password min 6 characters.' })

      if (!db.data.users) db.data.users = {}
      const targetKey = normalizedPhone + '@s.whatsapp.net'

      if (db.data.users[targetKey]?.password) {
        return sendJson(res, 200, { success: false, message: 'Number already registered.' })
      }

      const hashedPassword = await hashPassword(password)
      const otpResult = await sendOtp(conn, targetKey, 'register')
      if (!otpResult.ok) return sendJson(res, 200, { success: false, message: otpResult.message })

      _pendingOtp.get(targetKey).registerData = { hashedPassword, name: normalizedPhone }

      sendJson(res, 200, { success: true, message: 'Code sent to your WhatsApp.', pendingToken: otpResult.pendingToken, phone: normalizedPhone })
    } catch (err) {
      console.error('[REGISTER]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/login', async (req, res, ctx) => {
    try {
      await ensureDB()
      const { phone, password } = ctx.body
      if (!phone || !password) return sendJson(res, 200, { success: false, message: 'Incomplete data.' })

      const normalizedPhone = normalizePhone(phone)
      const authBlock = await checkDbRateLimit(`auth:${normalizedPhone}`, { windowMs: DB_LIMIT_WINDOW_MS, max: DB_LIMIT_MAX, blockMs: DB_LIMIT_BLOCK_MS })
      if (authBlock) return sendJson(res, 429, { success: false, message: authBlock })

      const targetKey = normalizedPhone + '@s.whatsapp.net'
      const user = db.data.users?.[targetKey]

      if (!user?.password) return sendJson(res, 200, { success: false, message: 'Number not registered.' })
      const passwordOk = await verifyPassword(password, user.password)
      if (!passwordOk) return sendJson(res, 200, { success: false, message: 'Incorrect password.' })

      if (!user.password.includes(':') || user.password.split(':')[1]?.length !== 128) {
        user.password = await hashPassword(password)
        db.write().catch(err => console.error('[DB WRITE]', err))
      }

      const otpResult = await sendOtp(conn, targetKey, 'login')
      if (!otpResult.ok) return sendJson(res, 200, { success: false, message: otpResult.message })

      sendJson(res, 200, { success: true, message: 'Code sent to your WhatsApp.', pendingToken: otpResult.pendingToken, phone: normalizedPhone })
    } catch (err) {
      console.error('[LOGIN]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/verify-otp', async (req, res, ctx) => {
    try {
      await ensureDB()
      const { phone, pendingToken, code } = ctx.body
      if (!phone || !pendingToken || !code) return sendJson(res, 200, { success: false, message: 'Incomplete data.' })

      const otpBlock = await checkDbRateLimit(`auth:${normalizePhone(phone)}`, { windowMs: DB_LIMIT_WINDOW_MS, max: 8, blockMs: DB_LIMIT_BLOCK_MS })
      if (otpBlock) return sendJson(res, 429, { success: false, message: otpBlock })

      const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
      const pendingRec = _pendingOtp.get(targetKey)
      const registerData = pendingRec?.registerData

      const result = verifyOtp(targetKey, pendingToken, code)
      if (!result.ok) return sendJson(res, 200, { success: false, message: result.message })

      if (result.purpose === 'register') {
        if (!registerData) return sendJson(res, 200, { success: false, message: 'Registration data expired. Please register again.' })
        if (!db.data.users) db.data.users = {}
        if (db.data.users[targetKey]?.password) {
          return sendJson(res, 200, { success: false, message: 'Number already registered.' })
        }

        db.data.users[targetKey] = {
          number: targetKey, exp: 0, gems: 0,
          limit: global.settings.tier.limit_capacity[0],
          registered: true, name: registerData.name, regTime: Date.now(),
          password: registerData.hashedPassword,
          premium: false, premiumTime: 0, daily: 0, level: 0,
          banned: false, warn: 0, role: 'user', autolevelup: false,
          afk: -1, afkReason: '', sname: '', sauth: '', email: '', age: -1,
          badge: { premium: {}, developer: false }
        }
      } else {
        if (!db.data.users?.[targetKey]) return sendJson(res, 200, { success: false, message: 'User not found.' })
      }

      if (db.data.sessions) {
        for (const [t, jid] of Object.entries(db.data.sessions)) {
          if (jid === targetKey) delete db.data.sessions[t]
        }
      }
      const token = generateToken(targetKey)
      if (!db.data.sessions) db.data.sessions = {}
      db.data.sessions[token] = targetKey
      db.data.sessions[ipSessionKey(req)] = targetKey
      await db.write()

      await clearDbRateLimit(`auth:${normalizePhone(phone)}`)

      sendJson(res, 200, {
        success: true,
        message: result.purpose === 'register' ? 'Registration successful.' : 'Login successful.',
        token
      })
    } catch (err) {
      console.error('[VERIFY-OTP]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/resend-otp', async (req, res, ctx) => {
    try {
      await ensureDB()
      const { phone } = ctx.body
      if (!phone) return sendJson(res, 200, { success: false, message: 'Incomplete data.' })

      const resendBlock = await checkDbRateLimit(`auth:${normalizePhone(phone)}`, { windowMs: DB_LIMIT_WINDOW_MS, max: 8, blockMs: DB_LIMIT_BLOCK_MS })
      if (resendBlock) return sendJson(res, 429, { success: false, message: resendBlock })

      const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
      const existing = _pendingOtp.get(targetKey)
      if (!existing) return sendJson(res, 200, { success: false, message: 'No pending verification for this number. Please start over.' })

      const registerData = existing.registerData
      const purpose = existing.purpose

      const otpResult = await sendOtp(conn, targetKey, purpose)
      if (!otpResult.ok) return sendJson(res, 200, { success: false, message: otpResult.message })
      if (registerData) _pendingOtp.get(targetKey).registerData = registerData

      sendJson(res, 200, { success: true, message: 'Code resent.', pendingToken: otpResult.pendingToken })
    } catch (err) {
      console.error('[RESEND-OTP]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  get('/api/profile', async (req, res) => {
    try {
      await ensureDB()
      const userKey = getUserKeyFromReq(req)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      const level = user.level ?? 0
      const maxTierLevel = Object.keys(global.settings.tier.name).length - 1

      const PROFILE_PIC_TTL = 10 * 60 * 1000
      let profilePic = user.profilePicCache || null
      const cacheAge = Date.now() - (user.profilePicCacheTime || 0)

      if (!profilePic || cacheAge > PROFILE_PIC_TTL) {
        try {
          const fresh = await withTimeout(conn.profilePictureUrl(userKey, 'image').catch(() => null), 4000)
          if (fresh) {
            profilePic = fresh
            user.profilePicCache = fresh
            user.profilePicCacheTime = Date.now()
          }
        } catch (_) {  }
      }

      sendJson(res, 200, {
        success: true,
        user: {
          phone: user.number || userKey,
          name: user.name || '-',
          profilePic,
          joined: user.regTime || null,
          limit: user.limit ?? 0,
          exp: user.exp ?? 0,
          gems: user.gems ?? 0,
          level,
          tier: global.settings.tier.name[level] || 'None',
          nextTier: level < maxTierLevel ? global.settings.tier.name[level + 1] : null,
          nextExp: level < maxTierLevel ? global.settings.tier.exp_required[level] : null,
          premium: user.premium || false,
          premiumTime: user.premiumTime || 0,
          premiumSince: user.premiumSince || 0,
          daily: user.daily || 0,
          number: user.number || '',
          lid: user.lid || '',
          spinCount: user.spinCount ?? 0,
          badge: user.badge || { premium: {}, developer: false },
          userKey,
          notification: Array.isArray(user.notification) ? user.notification.slice(-10).reverse() : []
        }
      })
    } catch (err) {
      console.error('[PROFILE]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/daily', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      const now = Date.now()
      const COOLDOWN = 24 * 60 * 60 * 1000

      if (user.daily && (now - user.daily) < COOLDOWN) {
        return sendJson(res, 200, { success: false, message: 'Not yet available.', remaining: user.daily + COOLDOWN - now })
      }

      const expReward = 500
      const gemReward = 5

      user.exp = (user.exp ?? 0) + expReward
      user.gems = (user.gems ?? 0) + gemReward
      user.daily = now
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, {
        success: true, exp: user.exp, gems: user.gems, daily: user.daily,
        expReward, gemReward,
        message: `Daily claimed! +${expReward} EXP, +${gemReward} Gems`
      })
    } catch (err) {
      console.error('[DAILY]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/tierup', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      const level = user.level ?? 0
      const maxLevel = Object.keys(global.settings.tier.name).length - 1
      if (level >= maxLevel) return sendJson(res, 200, { success: false, message: 'Already MAX TIER!' })

      const needed = global.settings.tier.exp_required[level]
      if ((user.exp ?? 0) < needed) return sendJson(res, 200, { success: false, message: 'Not enough EXP.', have: user.exp, need: needed })

      const oldTier = global.settings.tier.name[level]
      const newTier = global.settings.tier.name[level + 1]
      user.exp -= needed
      user.level = level + 1
      user.limit = global.settings.tier.limit_capacity[level + 1]
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, oldTier, newTier, exp: user.exp, level: user.level, limit: user.limit })
    } catch (err) {
      console.error('[TIER UP]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/change-password', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)

      const changePwBlock = checkMemoryRateLimit(`${getClientIp(req)}:${token || 'anon'}`, { windowMs: 10 * 60 * 1000, max: 5, blockMs: 15 * 60 * 1000 })
      if (changePwBlock) return sendJson(res, 429, { success: false, message: changePwBlock })

      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const { oldPassword, newPassword } = ctx.body
      if (!oldPassword || !newPassword) return sendJson(res, 200, { success: false, message: 'Incomplete data.' })
      if (newPassword.length < 6) return sendJson(res, 200, { success: false, message: 'Password min 6 characters.' })
      if (oldPassword === newPassword) return sendJson(res, 200, { success: false, message: 'New password must be different.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })
      const oldOk = await verifyPassword(oldPassword, user.password)
      if (!oldOk) return sendJson(res, 200, { success: false, message: 'Current password is incorrect.' })

      user.password = await hashPassword(newPassword)
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, message: 'Password updated successfully.' })
    } catch (err) {
      console.error('[change-password]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/rename', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const { newName } = ctx.body
      if (!newName || !newName.trim()) return sendJson(res, 200, { success: false, message: 'Name cannot be empty.' })
      if (newName.trim().length > 32) return sendJson(res, 200, { success: false, message: 'Name too long (max 32 chars).' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      user.name = newName.trim()
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, message: 'Name updated!', name: user.name })
    } catch (err) {
      console.error('[RENAME]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/redeem', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      const { code } = ctx.body
      if (!code || !code.trim()) return sendJson(res, 200, { success: false, message: 'Please enter a code.' })

      const inputCode = code.trim().toUpperCase()
      const botJid = conn.user?.jid || conn.user?.id || ''
      const codes = db.data.settings?.[botJid]?.code
      if (!Array.isArray(codes) || codes.length === 0) {
        return sendJson(res, 200, { success: false, message: 'No gift codes available.' })
      }

      const entry = codes.find(c => c[0].toUpperCase() === inputCode)
      if (!entry) return sendJson(res, 200, { success: false, message: 'Invalid or expired code.' })

      if (!user.redeemedCodes) user.redeemedCodes = []
      if (user.redeemedCodes.includes(inputCode)) {
        return sendJson(res, 200, { success: false, message: 'You have already redeemed this code.' })
      }

      const rewardStr = entry[1]
      const [rewardType, rewardVal] = rewardStr.split(':')
      const rewardNum = parseFloat(rewardVal)

      let rewardMessage = ''
      switch (rewardType) {
        case 'exp':
          user.exp = (user.exp ?? 0) + rewardNum
          rewardMessage = `+${rewardNum} EXP`
          break
        case 'gems':
          user.gems = (user.gems ?? 0) + rewardNum
          rewardMessage = `+${rewardNum} Gems`
          break
        case 'limit':
          user.limit = (user.limit ?? 0) + rewardNum
          rewardMessage = `+${rewardNum} Limit`
          break
        case 'premium': {
          const days = rewardNum
          const now = Date.now()
          const msPerDay = 86400000
          const graceMs = 86400000
          const streakBroken = !user.premiumSince || (user.premiumTime || 0) + graceMs < now
          if (streakBroken) user.premiumSince = now
          if (user.premium && user.premiumTime > now) {
            user.premiumTime = user.premiumTime + days * msPerDay
          } else {
            user.premium = true
            user.premiumTime = now + days * msPerDay
          }
          if (!user.badge) user.badge = {}
          user.badge.premium = { active: true, since: user.premiumSince }
          user.premiumExpiryNotified = false
          user.premiumExpiredNotified = false
          user.premiumStreakLostNotified = false
          rewardMessage = `Premium ${days} day${days !== 1 ? 's' : ''}`
          break
        }
        case 'level': {
          const maxLevel = Object.keys(global.settings.tier.name).length - 1
          const newLevel = Math.min(maxLevel, (user.level ?? 0) + rewardNum)
          user.level = newLevel
          user.limit = global.settings.tier.limit_capacity[newLevel]
          rewardMessage = `Level → ${global.settings.tier.name[newLevel]}`
          break
        }
        default:
          return sendJson(res, 200, { success: false, message: 'Unknown reward type.' })
      }

      user.redeemedCodes.push(inputCode)
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, {
        success: true, message: `Code redeemed! Reward: ${rewardMessage}`,
        rewardType, rewardNum, rewardMessage,
        exp: user.exp, limit: user.limit, level: user.level, gems: user.gems
      })
    } catch (err) {
      console.error('[REDEEM]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/buy-limit', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      let amount = parseInt(ctx.body.amount)
      if (isNaN(amount) || amount <= 0) return sendJson(res, 200, { success: false, message: 'Invalid amount.' })

      const currentLevel = user.level ?? 0
      const maxLimit = global.settings.tier.limit_capacity[currentLevel] ?? 10
      const remaining = maxLimit - (user.limit ?? 0)

      if (amount > remaining) {
        return sendJson(res, 200, { success: false, message: `Cannot buy more than ${remaining} limit(s). Max limit for your tier: ${maxLimit}` })
      }

      const totalCost = amount * BUY_LIMIT_PRICE
      if ((user.gems ?? 0) < totalCost) {
        return sendJson(res, 200, { success: false, message: `Not enough Gems! Need ${totalCost} Gems.` })
      }

      user.gems -= totalCost
      user.limit = (user.limit ?? 0) + amount
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, message: `Bought ${amount} limit(s)!`, gems: user.gems, limit: user.limit })
    } catch (err) {
      console.error('[BUY LIMIT]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/buy-premium', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      let weeks = parseInt(ctx.body.weeks)
      if (isNaN(weeks) || weeks <= 0) return sendJson(res, 200, { success: false, message: 'Invalid amount.' })

      const totalCost = weeks * BUY_PREMIUM_PRICE
      if ((user.gems ?? 0) < totalCost) {
        return sendJson(res, 200, { success: false, message: `Not enough Gems! Need ${totalCost} Gems.` })
      }

      user.gems -= totalCost

      const now = Date.now()
      const msPerWeek = 7 * 86400000
      const graceMs = 86400000

      const streakBroken = !user.premiumSince || (user.premiumTime || 0) + graceMs < now
      if (streakBroken) user.premiumSince = now

      if (user.premium && user.premiumTime > now) {
        user.premiumTime += weeks * msPerWeek
      } else {
        user.premium = true
        user.premiumTime = now + weeks * msPerWeek
      }

      const expiryStr = new Date(user.premiumTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      const buyMessage = `Premium extended by ${weeks} week(s)! Now active until ${expiryStr}.`
      pushNotification(user, buyMessage)

      if (!user.badge) user.badge = {}
      user.badge.premium = { active: true, since: user.premiumSince }

      user.premiumExpiryNotified = false
      user.premiumExpiredNotified = false
      user.premiumStreakLostNotified = false

      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, message: `Premium extended by ${weeks} week(s)!`, gems: user.gems, premium: user.premium, premiumTime: user.premiumTime, premiumSince: user.premiumSince })
    } catch (err) {
      console.error('[BUY PREMIUM]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/slot', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized.' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found.' })

      const currentExp = user.exp ?? 0
      const SPIN_COST = 200
      const PITY_LIMIT = 100
      const SPIN_COOLDOWN = 500

      if (currentExp < SPIN_COST) {
        return sendJson(res, 200, { success: false, message: `Not enough EXP! Need ${SPIN_COST} EXP to spin.` })
      }

      const now = Date.now()
      if (user.lastSpin && (now - user.lastSpin) < SPIN_COOLDOWN) {
        const wait = Math.ceil((SPIN_COOLDOWN - (now - user.lastSpin)) / 1000)
        return sendJson(res, 200, { success: false, message: `Cooldown! Wait ${wait}s before spinning again.` })
      }
      user.lastSpin = now

      if (typeof user.spinCount !== 'number') user.spinCount = 0

      function pickResult() {
        const r = Math.random() * 100
        if (r < 0.001) return '✦'
        if (r < 0.101) return '7'
        if (r < 0.601) return '♦'
        if (r < 1.601) return '♣'
        if (r < 3.101) return '♥'
        if (r < 5.101) return '♠'
        if (r < 8.101) return '♪'
        if (r < 12.101) return '✿'
        if (r < 42.101) return '×'
        return null
      }

      function getVisualIcon() {
        const icons = ['♣', '♦', '♠', '♥', '♪', '7', '×', '✦', '✿']
        return icons[Math.floor(Math.random() * icons.length)]
      }

      const isPity = user.spinCount >= PITY_LIMIT
      let slot1, slot2, slot3, isTriple, tripleSymbol

      if (isPity) {
        const pityPool = ['✦', '7', '♦']
        const weights = [10, 40, 50]
        const total = weights.reduce((a, b) => a + b, 0)
        let r = Math.random() * total
        let chosen = '♦'
        for (let i = 0; i < pityPool.length; i++) {
          r -= weights[i]
          if (r <= 0) { chosen = pityPool[i]; break }
        }
        slot1 = slot2 = slot3 = chosen
        isTriple = true
        tripleSymbol = chosen
      } else {
        tripleSymbol = pickResult()
        if (tripleSymbol) {
          slot1 = slot2 = slot3 = tripleSymbol
          isTriple = true
        } else {
          slot1 = getVisualIcon()
          do { slot2 = getVisualIcon() } while (slot2 === slot1)
          do { slot3 = getVisualIcon() } while (slot3 === slot1 || slot3 === slot2)
          isTriple = false
        }
      }

      const slots = [slot1, slot2, slot3]

      let reward = 0, winMessage = ''
      if (isTriple) {
        switch (tripleSymbol) {
          case '✦': reward = 200000; winMessage = 'ULTRA JACKPOT! ✦✦✦ +200k EXP'; break
          case '7': reward = 77777; winMessage = 'JACKPOT! 7 7 7 +77.7k EXP'; break
          case '♦': reward = 10000; winMessage = 'TRIPLE DIAMOND! +10k EXP'; break
          case '♣': reward = 5000; winMessage = 'TRIPLE CLUB! +5k EXP'; break
          case '♥': reward = 3000; winMessage = 'TRIPLE HEART! +3k EXP'; break
          case '♠': reward = 2000; winMessage = 'TRIPLE SPADE! +2k EXP'; break
          case '♪': reward = 1000; winMessage = 'TRIPLE NOTE! +1k EXP'; break
          case '✿': reward = 500; winMessage = 'TRIPLE FLOWER! +500 EXP'; break
          case '×': reward = -300; winMessage = 'TRIPLE CROSS! −300 EXP'; break
        }
      } else {
        reward = 0
        winMessage = `No match! −${SPIN_COST} EXP`
      }

      const isWin = reward > 0
      let expChange
      if (isTriple && tripleSymbol === '×') {
        expChange = -(SPIN_COST + 300)
      } else if (isWin) {
        expChange = reward - SPIN_COST
      } else {
        expChange = -SPIN_COST
      }

      if (isWin) user.spinCount = 0
      else user.spinCount += 1

      user.exp = Math.max(0, currentExp + expChange)

      db.write().catch(err => console.error('[SLOT] db.write failed', err))

      sendJson(res, 200, {
        success: true, slots, reward, cost: SPIN_COST, expChange,
        newExp: user.exp, winMessage, isWin,
        isPity, spinCount: user.spinCount, pityLimit: PITY_LIMIT,
        spinsUntilPity: Math.max(0, PITY_LIMIT - user.spinCount)
      })
    } catch (err) {
      console.error('[SLOT]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  get('/api/gems', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const userKey = getUserKeyFromToken(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized' })

      const user = db.data.users?.[userKey]
      if (!user) return sendJson(res, 200, { success: false, message: 'User not found' })

      sendJson(res, 200, { success: true, gems: user.gems || 0 })
    } catch (err) {
      console.error('[GEMS]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/logout', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      if (token && db.data.sessions?.[token]) {
        delete db.data.sessions[token]
      }
      const ipKey = ipSessionKey(req)
      if (db.data.sessions?.[ipKey]) {
        delete db.data.sessions[ipKey]
      }
      db.write().catch(err => console.error('[DB WRITE]', err))
      sendJson(res, 200, { success: true })
    } catch (err) {
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  get('/api/check-owner', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey, isOwner } = checkOwner(token)
      if (!userKey) return sendJson(res, 200, { success: false, isOwner: false })
      sendJson(res, 200, { success: true, isOwner })
    } catch (err) {
      sendJson(res, 200, { success: false, isOwner: false })
    }
  })


  get('/api/admin/giftcodes', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey, isOwner } = checkOwner(token)
      if (!userKey || !isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const botJid = conn.user?.jid || conn.user?.id || ''
      const codes = db.data.settings?.[botJid]?.code || []
      sendJson(res, 200, { success: true, codes })
    } catch (err) {
      console.error('[ADMIN/GIFTCODES GET]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })

  post('/api/admin/giftcodes/add', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey, isOwner } = checkOwner(token)
      if (!userKey || !isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const { code, reward } = ctx.body
      if (!code || !reward) return sendJson(res, 200, { success: false, message: 'Invalid data' })

      const botJid = conn.user?.jid || conn.user?.id || ''
      if (!db.data.settings) db.data.settings = {}
      if (!db.data.settings[botJid]) db.data.settings[botJid] = {}
      if (!Array.isArray(db.data.settings[botJid].code)) db.data.settings[botJid].code = []

      const codes = db.data.settings[botJid].code
      const upperCode = code.trim().toUpperCase()
      if (codes.find(c => c[0].toUpperCase() === upperCode)) {
        return sendJson(res, 200, { success: false, message: 'Code already exists.' })
      }

      codes.push([upperCode, reward.trim()])
      db.write().catch(err => console.error('[DB WRITE]', err))
      sendJson(res, 200, { success: true, codes })
    } catch (err) {
      console.error('[ADMIN/GIFTCODES ADD]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })

  post('/api/admin/giftcodes/delete', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey, isOwner } = checkOwner(token)
      if (!userKey || !isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const { code } = ctx.body
      if (!code) return sendJson(res, 200, { success: false, message: 'Invalid data' })

      const botJid = conn.user?.jid || conn.user?.id || ''
      const codes = db.data.settings?.[botJid]?.code
      if (!Array.isArray(codes)) return sendJson(res, 200, { success: false, message: 'No codes found.' })

      const upperCode = code.trim().toUpperCase()
      const idx = codes.findIndex(c => c[0].toUpperCase() === upperCode)
      if (idx === -1) return sendJson(res, 200, { success: false, message: 'Code not found.' })

      codes.splice(idx, 1)
      db.write().catch(err => console.error('[DB WRITE]', err))
      sendJson(res, 200, { success: true, codes })
    } catch (err) {
      console.error('[ADMIN/GIFTCODES DELETE]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  get('/api/premium-notice', async (req, res) => {
    try {
      await ensureDB()
      const userKey = getUserKeyFromReq(req)
      if (!userKey) return sendJson(res, 200, { success: true, notice: null })

      const user = db.data.users?.[userKey]
      if (!user || !user.premiumTime) return sendJson(res, 200, { success: true, notice: null })

      const now = Date.now()
      const dayMs = 86400000
      const graceMs = 86400000
      const expiresAt = user.premiumTime

      let notice = null
      if (expiresAt > now) {
        const msLeft = expiresAt - now
        if (msLeft <= dayMs) {
          notice = { type: 'expiring_tomorrow', expiresAt, message: 'Your premium will expire tomorrow. Wanna keep your streak?' }
        } else if (msLeft <= 3 * dayMs) {
          const dateStr = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          notice = { type: 'expiring_soon', expiresAt, message: `Your premium will expire at ${dateStr}.` }
        }
      } else if (expiresAt + graceMs > now) {
        const hoursLeft = Math.ceil((expiresAt + graceMs - now) / 3600000)
        notice = { type: 'grace_period', expiresAt, message: `Your premium expired! Renew within ${hoursLeft}h to keep your streak.` }
      } else if (user.premiumSince) {
        notice = { type: 'streak_lost', expiresAt, message: 'Your premium streak has been reset.' }
      }

      sendJson(res, 200, { success: true, notice })
    } catch (err) {
      console.error('[PREMIUM-NOTICE]', err)
      sendJson(res, 200, { success: true, notice: null })
    }
  })

  get('/api/user-search', async (req, res) => {
    try {
      await ensureDB()
      const urlObj = new URL(req.url, `http://${req.headers.host}`)
      const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase()
      if (!q || q.length < 2) return sendJson(res, 200, { success: true, results: [] })

      const digitsOnly = q.replace(/\D/g, '')
      const tierNames = global.settings?.tier?.name || {}
      const tierExp = global.settings?.tier?.exp_required || {}
      const maxTierLevel = Object.keys(tierNames).length - 1

      const matches = Object.entries(db.data?.users || {})
        .filter(([key]) => !key.endsWith('@g.us'))
        .filter(([key, u]) => {
          const phoneDigits = key.replace(/\D/g, '')
          const nameMatch = (u.name || '').toLowerCase().includes(q)
          const numberMatch = (u.number || '').toLowerCase().includes(q)
          const phoneMatch = digitsOnly.length >= 2 && phoneDigits.includes(digitsOnly)
          return nameMatch || numberMatch || phoneMatch
        })
        .slice(0, 10)
        .map(([key, u]) => {
          const level = u.level ?? 0
          return {
            userKey: key,
            phone: u.number || key.replace('@s.whatsapp.net', ''),
            name: u.name || '-',
            level,
            tier: tierNames[level] || 'None',
            badge: u.badge || { premium: {}, developer: false },
            premium: u.premium || false,
            premiumTime: u.premiumTime || 0,
            premiumSince: u.premiumSince || 0,
            nextExp: level < maxTierLevel ? tierExp[level] : null,
            profilePicCache: u.profilePicCache || null
          }
        })

      sendJson(res, 200, { success: true, results: matches })
    } catch (err) {
      console.error('[USER-SEARCH]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })

  get('/api/admin/users', async (req, res) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey, isOwner } = checkOwner(token)
      if (!userKey) return sendJson(res, 200, { success: false, message: 'Unauthorized' })
      if (!isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const users = Object.entries(db.data?.users || {})
        .filter(([key]) => !key.endsWith('@g.us'))
        .map(([key, val]) => ({ userKey: key, ...val }))

      sendJson(res, 200, { success: true, users })
    } catch (err) {
      console.error('[ADMIN/USERS]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })

  post('/api/admin/update-user', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey: callerKey, isOwner } = checkOwner(token)
      if (!callerKey) return sendJson(res, 200, { success: false, message: 'Unauthorized' })
      if (!isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const { userKey: targetKey, field, value } = ctx.body
      if (!targetKey || !field) return sendJson(res, 200, { success: false, message: 'Invalid data' })
      if (!db.data?.users?.[targetKey]) return sendJson(res, 200, { success: false, message: 'User not found' })

      const user = db.data.users[targetKey]

      if (['exp', 'limit', 'level', 'warn', 'age', 'gems'].includes(field)) {
        user[field] = parseInt(value) || 0
      } else if (['premium', 'banned', 'registered', 'autolevelup'].includes(field)) {
        user[field] = value === true || value === 'true'
      } else if (['premiumTime', 'regTime', 'daily', 'afk'].includes(field)) {
        user[field] = Number(value) || 0
      } else {
        user[field] = value
      }

      db.write().catch(err => console.error('[DB WRITE]', err))
      sendJson(res, 200, { success: true, message: 'Updated', userKey: targetKey, field, value: user[field] })
    } catch (err) {
      console.error('[ADMIN/UPDATE-USER]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })

  post('/api/admin/delete-user', async (req, res, ctx) => {
    try {
      await ensureDB()
      const token = getToken(req)
      const { userKey: callerKey, isOwner } = checkOwner(token)
      if (!callerKey) return sendJson(res, 200, { success: false, message: 'Unauthorized' })
      if (!isOwner) return sendJson(res, 200, { success: false, message: 'Forbidden' })

      const { userKey: targetKey } = ctx.body
      if (!targetKey) return sendJson(res, 200, { success: false, message: 'Invalid data' })
      if (!db.data?.users?.[targetKey]) return sendJson(res, 200, { success: false, message: 'User not found' })

      delete db.data.users[targetKey]
      db.write().catch(err => console.error('[DB WRITE]', err))

      sendJson(res, 200, { success: true, message: 'User deleted' })
    } catch (err) {
      console.error('[admin/delete-user]', err)
      sendJson(res, 200, { success: false, message: 'Internal error' })
    }
  })


  post('/api/check-number', async (req, res, ctx) => {
    try {
      await ensureDB()
      const { phone } = ctx.body
      if (!phone) return sendJson(res, 200, { exists: false })
      const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
      sendJson(res, 200, { exists: !!db.data.users?.[targetKey] })
    } catch (err) {
      console.error('[check-number]', err)
      sendJson(res, 200, { exists: false })
    }
  })

  const PREMIUM_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000
  const PREMIUM_GRACE_MS = 86400000
  setInterval(async () => {
    try {
      await ensureDB()
      const now = Date.now()
      let changed = false
      for (const [userKey, user] of Object.entries(db.data.users || {})) {
        if (!user || !user.premiumTime) continue
        const msLeft = user.premiumTime - now

        if (user.premium && msLeft > 0 && msLeft <= PREMIUM_REMINDER_WINDOW_MS && !user.premiumExpiryNotified) {
          const expiryStr = new Date(user.premiumTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          const msg = `Your premium is about to expire (${expiryStr}). Renew now to keep your streak!`
          pushNotification(user, msg)
          sendWaNotif(conn, userKey, msg).catch(() => {})
          user.premiumExpiryNotified = true
          changed = true
        } else if (msLeft > PREMIUM_REMINDER_WINDOW_MS && user.premiumExpiryNotified) {
          user.premiumExpiryNotified = false
          changed = true
        }

        if (user.premium && msLeft <= 0 && !user.premiumExpiredNotified) {
          pushNotification(user, `Your premium has expired. Renew within 24h to keep your streak!`)
          user.premiumExpiredNotified = true
          user.premium = false
          changed = true
        } else if (msLeft > 0 && user.premiumExpiredNotified) {
          user.premiumExpiredNotified = false
          changed = true
        }

        if (msLeft <= -PREMIUM_GRACE_MS && user.premiumSince && !user.premiumStreakLostNotified) {
          pushNotification(user, `Your premium streak has been reset.`)
          if (!user.badge) user.badge = {}
          user.badge.premium = {}
          user.premiumSince = 0
          user.premiumStreakLostNotified = true
          changed = true
        } else if (msLeft > -PREMIUM_GRACE_MS && user.premiumStreakLostNotified) {
          user.premiumStreakLostNotified = false
          changed = true
        }
      }
      if (changed) await db.write()
    } catch (err) {
      console.error('[PREMIUM REMINDER]', err)
    }
  }, 15 * 60 * 1000).unref()

  return routes
}

function pipeEmit(event, event2, prefix = '') {
  let oldEmit = event.emit
  event.emit = function(ev, ...args) {
    try {
      oldEmit.call(event, ev, ...args)
      event2?.emit?.(prefix + ev, ...args)
    } catch (err) {
      console.error('[pipeEmit]', err.message)
    }
  }
  return { unpipeEmit: () => event.emit = oldEmit }
}

let _server = null, _wss = null, _unpipe = null, _routes = null

global.registerHtmlAction = registerHtmlAction

global.authHelpers = {
  sendOtp,
  verifyOtp,
  hashPassword,
  verifyPassword,
  normalizePhone,
  generateToken,
  checkDbRateLimit,
  clearDbRateLimit,
  ensureDB,
}

function connect(conn, PORT) {
  if (!_server) {
    _routes = buildRoutes(conn)

    _server = global.server = createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`)
        const pathname = urlObj.pathname

        const CORS_ENABLED_PATHS = [
          '/api/aiRich/action',
          '/api/login',
          '/api/register',
          '/api/verify-otp',
          '/api/resend-otp'
        ]
        if (CORS_ENABLED_PATHS.includes(pathname)) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          if (req.method === 'OPTIONS') {
            res.writeHead(204)
            return res.end()
          }
        }


        if (pathname.startsWith('/api/')) {
          const block = checkMemoryRateLimit(getClientIp(req), { windowMs: 60 * 1000, max: 120, blockMs: 60 * 1000 })
          if (block) return sendJson(res, 429, { success: false, message: block })
        }


        req.setTimeout(25000, () => {
          if (!res.headersSent) sendJson(res, 504, { success: false, message: 'Gateway Timeout' })
        })


        if (req.headers['accept']?.includes('text/html')) {
          setCookie(res, 'bypass-tunnel-reminder', '1', { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'Lax' })
        }
        res.setHeader('bypass-tunnel-reminder', '1')


        if (req.method === 'GET' && pathname.startsWith('/files/')) {
          const served = await serveUploadedFile(res, pathname.slice('/files/'.length))
          if (served) return
          return sendJson(res, 404, { success: false, message: 'File not found or expired.' })
        }

        const match = _routes.find(([method, p]) => method === req.method && p === pathname)

        if (match) {
          const [, , handler] = match
          const isMultipart = (req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data')
          let body = {}
          if (!isMultipart && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
            try {
              body = await readJsonBody(req)
            } catch (e) {
              return sendJson(res, 400, { success: false, message: 'Invalid JSON body' })
            }
          }
          await handler(req, res, { body, conn })
          return
        }

        if (req.method === 'GET') {
          const served = await serveStatic(req, res, pathname)
          if (served) return
        }

        sendJson(res, 404, { success: false, message: 'Not found' })
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { success: false, message: 'Internal error' })
      }
    })


    _wss = new WebSocketServer({ server: _server })
    _wss.on('connection', (ws, req) => {
      ws.on('error', err => console.error('• [ WS ] Error:', err.message))

      ws.on('message', async (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }

        if (msg.type === 'ping') {
          return ws.send(JSON.stringify({ type: 'pong' }))
        }

        if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
          subscribeWs(ws, msg.channel)
          return
        }

        if (msg.type === 'aiRichAction') {
          try {
            const { type, token, requestId, ...args } = msg
            const result = await performHtmlAction(conn, token, args)
            ws.send(JSON.stringify({ type: 'aiRichActionResult', requestId, ...result }))
          } catch (err) {
            ws.send(JSON.stringify({ type: 'aiRichActionResult', requestId: msg.requestId, success: false, message: err.message }))
          }
        }
      })
      ws.once('close', () => unsubscribeWsFromAll(ws))

      const { unpipeEmit } = pipeEmit(conn, {
        emit: (ev, ...args) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ event: ev, args }))
          }
        }
      }, 'conn-')
      ws.once('close', unpipeEmit)
    })

    _server.listen(PORT, '0.0.0.0')
  }

  if (_unpipe) _unpipe()
  if (_wss) {
    const { unpipeEmit } = pipeEmit(conn, {
      emit: (ev, ...args) => {
        for (const ws of _wss.clients) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: ev, args }))
        }
      }
    }, 'conn-')
    _unpipe = unpipeEmit
  }

  return _server
}

export default connect
