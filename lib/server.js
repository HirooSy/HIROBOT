import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { Server } from 'socket.io'
import Helper from './helper.js'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import db, { loadDatabase } from './database.js'
import chalk from 'chalk'

const scryptAsync = promisify(scrypt)

// ============ PASSWORD HASHING (scrypt, built into Node — no extra deps needed) ============
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(password, salt, 64)
  return `${salt}:${derived.toString('hex')}`
}

async function verifyPassword(password, stored) {
  if (!stored) return false
  const parts = stored.split(':')
  if (parts.length !== 2 || parts[1].length !== 128) {
    // Legacy plaintext password from before this patch — compare directly (timing-safe).
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

// ============ SIMPLE IN-MEMORY RATE LIMITER (anti brute-force) ============
const _attempts = new Map()

function rateLimit(opts, keyFn) {
  const { windowMs, max, blockMs } = opts
  return (req, res, next) => {
    const key = keyFn(req)
    const now = Date.now()
    let rec = _attempts.get(key)

    if (rec && rec.blockedUntil && now < rec.blockedUntil) {
      const waitSec = Math.ceil((rec.blockedUntil - now) / 1000)
      return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${waitSec}s.` })
    }

    if (!rec || now - rec.firstAt > windowMs) {
      rec = { count: 0, firstAt: now, blockedUntil: 0 }
    }

    rec.count++
    if (rec.count > max) {
      rec.blockedUntil = now + blockMs
      _attempts.set(key, rec)
      const waitSec = Math.ceil(blockMs / 1000)
      return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${waitSec}s.` })
    }

    _attempts.set(key, rec)
    next()
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, rec] of _attempts) {
    if (now - rec.firstAt > 60 * 60 * 1000 && (!rec.blockedUntil || now > rec.blockedUntil)) {
      _attempts.delete(key)
    }
  }
}, 10 * 60 * 1000).unref()

// changePwLimiter and generalLimiter stay in-memory/per-IP: they're a light
// abuse guard, not the primary account-takeover defense, so surviving a
// restart or being IP-agnostic isn't critical for them.
const changePwLimiter = rateLimit(
  { windowMs: 10 * 60 * 1000, max: 5, blockMs: 15 * 60 * 1000 },
  req => `${req.ip}:${getToken(req) || 'anon'}`
)

const generalLimiter = rateLimit(
  { windowMs: 60 * 1000, max: 120, blockMs: 60 * 1000 },
  req => req.ip
)

// ============ DB-BACKED RATE LIMITER (anti brute-force, keyed by phone) ============
// An in-memory/per-IP limiter is trivially bypassed by switching browsers,
// devices, or IPs (VPN, mobile data vs wifi, etc), since each looks like a
// "new" client with a fresh counter. Login/register/OTP attempts instead key
// on the *target phone number* and persist through db.write(), so the limit
// follows the account being attacked regardless of who/where the requests
// come from, and survives a server restart too.
const DB_LIMIT_WINDOW_MS = 10 * 60 * 1000   // 10 minute rolling window
const DB_LIMIT_MAX = 5                       // 5 attempts per window
const DB_LIMIT_BLOCK_MS = 15 * 60 * 1000    // then blocked for 15 minutes

function ensureBruteforceStore() {
  if (!db.data.bruteforce) db.data.bruteforce = {}
}

// Checks + increments the counter for `key` before the route handler runs.
// Returns null to continue, or a message string if the request should be blocked.
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

// Call on a successful login/OTP verification to clear the counter for that
// number, so a legitimate user isn't stuck half-throttled after they finally
// get it right.
async function clearDbRateLimit(key) {
  await ensureDB()
  ensureBruteforceStore()
  if (db.data.bruteforce[key]) {
    delete db.data.bruteforce[key]
    await db.write()
  }
}

// Periodic cleanup so db.data.bruteforce doesn't grow forever with stale entries.
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

// Express middleware wrapper around checkDbRateLimit, keyed by normalized phone.
function dbAuthLimiter(opts) {
  return async (req, res, next) => {
    const phone = normalizePhone((req.body && req.body.phone) || '')
    if (!phone) return res.json({ success: false, message: 'Incomplete data.' })
    const blockMessage = await checkDbRateLimit(`auth:${phone}`, opts)
    if (blockMessage) return res.status(429).json({ success: false, message: blockMessage })
    next()
  }
}

const authLimiter = dbAuthLimiter({ windowMs: DB_LIMIT_WINDOW_MS, max: DB_LIMIT_MAX, blockMs: DB_LIMIT_BLOCK_MS })
// OTP verification gets a slightly tighter window since guessing a 6-digit
// code is the more sensitive of the two attack surfaces.
const otpVerifyLimiter = dbAuthLimiter({ windowMs: DB_LIMIT_WINDOW_MS, max: 8, blockMs: DB_LIMIT_BLOCK_MS })

// ============ OTP STORE (in-memory ONLY — never written to db.data / disk) ============
// Keeping this out of the lowdb store means it can never leak through a data
// dump, a misconfigured admin endpoint, or the JSON file itself — it only
// ever exists in this process's RAM and is gone on restart or expiry.
const _pendingOtp = new Map() // targetKey -> { code, expiresAt, attempts, purpose, pendingToken }

const OTP_TTL_MS = 5 * 60 * 1000       // OTP valid for 5 minutes
const OTP_MAX_ATTEMPTS = 5             // wrong guesses allowed before the code is voided
const OTP_RESEND_COOLDOWN_MS = 60 * 1000 // must wait 1 min before a fresh code can be requested

function generateOtpCode() {
  // 6-digit numeric code, cryptographically random (not Math.random)
  return String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')
}

async function sendOtp(conn, targetKey, purpose) {
  const existing = _pendingOtp.get(targetKey)
  if (existing && Date.now() - (existing.sentAt || 0) < OTP_RESEND_COOLDOWN_MS) {
    return { ok: false, message: 'Please wait before requesting another code.' }
  }

  const code = generateOtpCode()
  const pendingToken = generateToken(targetKey) // opaque handle the client uses to reference this OTP session
  _pendingOtp.set(targetKey, {
    code,
    purpose, // 'login' | 'register'
    expiresAt: Date.now() + OTP_TTL_MS,
    sentAt: Date.now(),
    attempts: 0,
    pendingToken
  })

  const displayName = db.data.users?.[targetKey]?.name || normalizePhone(targetKey)
  const otpMessage = {
    text: `Hi ${displayName}. Here's your ${purpose === 'register' ? 'registration' : 'login'} code, don't give this code to anyone.\n\nCode expires in 5 minutes.`,
    nativeFlow: [
      { text: 'COPY CODE', copy: code },
    ]
  }

  // Baileys' getUSyncDevices occasionally throws a transient
  // "Connection Closed" (statusCode 428) on send attempts, even while the
  // socket is otherwise healthy and normal messages/commands go through
  // fine (known upstream issue in Baileys v7 rc builds). Retry with
  // backoff clears it in most cases without masking a genuinely
  // unregistered/invalid number.
  const isTransient428 = (err) => {
    const statusCode = err?.output?.statusCode ?? err?.data?.output?.statusCode
    return statusCode === 428 || err?.message === 'Connection Closed'
  }

  const MAX_ATTEMPTS = 3
  const RETRY_DELAYS_MS = [1000, 2000] // backoff before attempt 2 and 3

  let lastErr = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await conn.sendMessage(targetKey, otpMessage)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1
      if (!isLastAttempt && isTransient428(err)) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 2000
        console.warn(`[OTP SEND] transient 428 (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`)
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

// Periodic cleanup of expired OTPs so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [key, rec] of _pendingOtp) {
    if (now > rec.expiresAt) _pendingOtp.delete(key)
  }
}, 60 * 1000).unref()

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const _adventureLocks = new Set()

async function ensureDB() {
  if (db.data == null) await loadDatabase()
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
  return req.headers['authorization']?.replace('Bearer ', '') || null
}

function getUserKeyFromToken(token) {
  return token ? db.data.sessions?.[token] : null
}

// ============ IP-BASED SESSION FALLBACK ============
// Quick tunnels (cloudflared trycloudflare.com, localtunnel, etc.) hand out a
// brand new random hostname every time the tunnel restarts. Since the login
// token lives in the browser's localStorage — which is scoped to the *origin*
// (hostname) — a new tunnel URL means a new origin, and the previously saved
// token becomes unreachable even though it's still valid server-side. This
// reuses the same db.data.sessions map (no separate store) by also keying an
// entry under `ip:<address>` alongside the normal `<token>` entry, so
// /api/profile (or any route that opts in) can still resolve who's asking
// even when the Authorization header is missing.
//
// SECURITY NOTE: this is intentionally a soft fallback, not a replacement for
// the token. Anyone sharing the same public IP as a logged-in user (same
// office/campus wifi, same mobile carrier CGNAT, same household) would be
// treated as that user for routes that use this fallback. Keep its use
// limited to low-sensitivity read routes (like viewing your own profile) and
// don't wire it into anything that changes account state, money/gems,
// passwords, or admin actions.
function ipSessionKey(req) {
  return `ip:${req.ip}`
}

// Try the Authorization token first (the real session); fall back to the IP
// hint only if there's no usable token. Use this instead of
// getUserKeyFromToken(getToken(req)) on routes that should survive a tunnel
// URL change.
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
  const isOwner = (global.owner || []).some(o => o[0] === phoneNumber)
  return { userKey, isOwner }
}

let _app = null, _server = null, _io = null, _unpipe = null

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

function connect(conn, PORT) {
  if (!_server) {
    _app = global.app = express()
    _server = global.server = createServer(_app)

    // Requests coming through localtunnel arrive via its relay, so Express
    // needs to trust that proxy to correctly resolve req.ip / req.protocol
    // (otherwise things like secure-cookie checks or rate limiting can behave
    // incorrectly, unlike when hitting the server directly by IP).
    _app.set('trust proxy', true)

    _app.use(express.json({ limit: '20mb' }))
    _app.use(express.urlencoded({ extended: true }))

    _app.use((req, res, next) => {
      // Localtunnel routes traffic through a remote relay, which adds extra
      // round-trip latency compared to hitting the server via raw IP. 10s was
      // too tight for that extra hop and caused sporadic 504 -> "Connection
      // error" on the client even though the server was healthy. 25s gives
      // enough headroom for tunnel traffic while still protecting against
      // truly stuck requests.
      req.setTimeout(25000, () => !res.headersSent && res.status(504).json({ success: false, message: 'Gateway Timeout' }))
      next()
    })

    _app.use((req, res, next) => {
      if (req.headers['accept']?.includes('text/html')) {
        res.cookie('bypass-tunnel-reminder', '1', { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: false })
      }
      res.setHeader('bypass-tunnel-reminder', '1')
      next()
    })

    _app.use((req, res, next) => {
      if (req.path.endsWith('.html')) {
        const clean = req.path.slice(0, -5)
        return res.redirect(301, clean === '/index' ? '/' : clean + (req.url.includes('?') ? req.url.slice(req.path.length) : ''))
      }
      next()
    })

    _app.use(express.static(path.join(__dirname, 'views'), { extensions: ['html'] }))

    // lib/src (icon.png, avatar_contact.png, dst) itu folder terpisah dari
    // views/ (sejajar, sama-sama di dalam lib/). HTML di views/ mereferensi
    // asetnya lewat "/src/..." apa adanya, jadi di-mount di sini biar path
    // itu kepetakan ke lokasi aslinya tanpa perlu pindahin filenya.
    _app.use('/src', express.static(path.join(__dirname, './src')))

    // Apply a generous general rate limit to all /api/* routes to blunt scripted abuse,
    // on top of the stricter limiters on login/register/change-password below.
    _app.use('/api', generalLimiter)

    // Lightweight liveness check — no DB, no rate limiter, no auth. Used by
    // the tunnel health monitor in system/main.js to tell "server itself is
    // down" apart from "server's fine but the tunnel URL stopped resolving".
    _app.get('/api/health', (req, res) => {
      res.json({ ok: true, uptime: process.uptime() })
    })

    _app.get('/api/tierAsset', (req, res) => {
      res.json(global.tierAsset)
    })
    _app.get('/api/botInfo', (req, res) => {
      res.json({ name: process.env.BOT_NAME })
    })
    _app.get('/api/commandList', async (req, res) => {
      try {
        const { plugins } = await import('./plugins.js')
        const commands = Object.values(plugins)
          .filter(plugin => !plugin.disabled && plugin.help)
          .flatMap(plugin => Array.isArray(plugin.help) ? plugin.help : [plugin.help])
          .map(h => h.split(' ')[0])
          .filter((h, i, arr) => arr.indexOf(h) === i)
          .sort()
        res.json({ total: commands.length, commands })
      } catch (e) {
        res.json({ total: 0, commands: [] })
      }
    })
    _app.get('/api/envExample', async (req, res) => {
      try {
        const envPath = path.join(__dirname, '../.env.example')
        const content = await (await import('fs/promises')).readFile(envPath, 'utf-8')
        res.json({ content })
      } catch (e) {
        res.json({ content: '' })
      }
    })

    // ============ REGISTER (step 1: validate + send OTP) ============
    _app.post('/api/register', authLimiter, async (req, res) => {
      try {
        await ensureDB()
        const { phone, password } = req.body
        if (!phone || !password) return res.json({ success: false, message: 'Incomplete data.' })
        if (password.length < 6) return res.json({ success: false, message: 'Password min 6 characters.' })

        if (!db.data.users) db.data.users = {}
        const targetKey = normalizePhone(phone) + '@s.whatsapp.net'

        if (db.data.users[targetKey]?.password) {
          return res.json({ success: false, message: 'Number already registered.' })
        }

        // Don't create the user record yet — only after OTP is verified in
        // /api/verify-otp. Stash the hashed password + intended profile fields
        // in memory alongside the OTP so verify-otp can finish the job.
        const hashedPassword = await hashPassword(password)
        const otpResult = await sendOtp(conn, targetKey, 'register')
        if (!otpResult.ok) return res.json({ success: false, message: otpResult.message })

        _pendingOtp.get(targetKey).registerData = { hashedPassword, name: normalizePhone(phone) }

        res.json({ success: true, message: 'Code sent to your WhatsApp.', pendingToken: otpResult.pendingToken, phone: normalizePhone(phone) })
      } catch (err) {
        console.error('[REGISTER]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ LOGIN (step 1: verify password + send OTP) ============
    _app.post('/api/login', authLimiter, async (req, res) => {
      try {
        await ensureDB()
        const { phone, password } = req.body
        if (!phone || !password) return res.json({ success: false, message: 'Incomplete data.' })

        const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
        const user = db.data.users?.[targetKey]

        if (!user?.password) return res.json({ success: false, message: 'Number not registered.' })
        const passwordOk = await verifyPassword(password, user.password)
        if (!passwordOk) return res.json({ success: false, message: 'Incorrect password.' })

        // Transparently upgrade legacy plaintext passwords to hashed form on successful login.
        if (!user.password.includes(':') || user.password.split(':')[1]?.length !== 128) {
          user.password = await hashPassword(password)
          db.write().catch(err => console.error('[DB WRITE]', err))
        }

        const otpResult = await sendOtp(conn, targetKey, 'login')
        if (!otpResult.ok) return res.json({ success: false, message: otpResult.message })

        res.json({ success: true, message: 'Code sent to your WhatsApp.', pendingToken: otpResult.pendingToken, phone: normalizePhone(phone) })
      } catch (err) {
        console.error('[LOGIN]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ VERIFY OTP (step 2: for both login and register) ============
    _app.post('/api/verify-otp', otpVerifyLimiter, async (req, res) => {
      try {
        await ensureDB()
        const { phone, pendingToken, code } = req.body
        if (!phone || !pendingToken || !code) return res.json({ success: false, message: 'Incomplete data.' })

        const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
        const pendingRec = _pendingOtp.get(targetKey)
        const registerData = pendingRec?.registerData // grab before verifyOtp deletes the record

        const result = verifyOtp(targetKey, pendingToken, code)
        if (!result.ok) return res.json({ success: false, message: result.message })

        if (result.purpose === 'register') {
          if (!registerData) return res.json({ success: false, message: 'Registration data expired. Please register again.' })
          if (!db.data.users) db.data.users = {}
          if (db.data.users[targetKey]?.password) {
            return res.json({ success: false, message: 'Number already registered.' })
          }

          db.data.users[targetKey] = {
            number: targetKey,
            exp: 0,
            gems: 0,
            limit: global.tierAsset.limit[0],
            registered: true,
            name: registerData.name,
            regTime: Date.now(),
            password: registerData.hashedPassword,
            premium: false, premiumTime: 0, daily: 0, level: 0,
            banned: false, warn: 0, role: 'user', autolevelup: false,
            afk: -1, afkReason: '', sname: '', sauth: '', email: '', age: -1
          }
          // db.write() deferred — the session write right below covers
          // both changes in a single disk write instead of two.
        } else {
          // login: just needs the user to already exist
          if (!db.data.users?.[targetKey]) return res.json({ success: false, message: 'User not found.' })
        }

        // Invalidate any previous sessions for this user, then issue a fresh one.
        if (db.data.sessions) {
          for (const [t, jid] of Object.entries(db.data.sessions)) {
            if (jid === targetKey) delete db.data.sessions[t]
          }
        }
        const token = generateToken(targetKey)
        if (!db.data.sessions) db.data.sessions = {}
        db.data.sessions[token] = targetKey
        // Remember this IP as belonging to this user for a while, so that if
        // a quick-tunnel restart changes the origin (and the browser loses
        // its saved token), routes using getUserKeyFromReq can still
        // recognize them without forcing a fresh login.
        db.data.sessions[ipSessionKey(req)] = targetKey
        // Single write covers both the new/updated user record (if this was
        // a registration) and the new session token — previously this was
        // two separate full-file writes back to back.
        await db.write()

        // Success — clear the brute-force counter for this phone so a legit
        // user isn't left half-throttled after finally getting it right.
        await clearDbRateLimit(`auth:${normalizePhone(phone)}`)

        res.json({
          success: true,
          message: result.purpose === 'register' ? 'Registration successful.' : 'Login successful.',
          token
        })
      } catch (err) {
        console.error('[VERIFY-OTP]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ RESEND OTP ============
    _app.post('/api/resend-otp', otpVerifyLimiter, async (req, res) => {
      try {
        await ensureDB()
        const { phone } = req.body
        if (!phone) return res.json({ success: false, message: 'Incomplete data.' })

        const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
        const existing = _pendingOtp.get(targetKey)
        if (!existing) return res.json({ success: false, message: 'No pending verification for this number. Please start over.' })

        // Preserve register data (if any) across the resend.
        const registerData = existing.registerData
        const purpose = existing.purpose

        const otpResult = await sendOtp(conn, targetKey, purpose)
        if (!otpResult.ok) return res.json({ success: false, message: otpResult.message })
        if (registerData) _pendingOtp.get(targetKey).registerData = registerData

        res.json({ success: true, message: 'Code resent.', pendingToken: otpResult.pendingToken })
      } catch (err) {
        console.error('[RESEND-OTP]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ PROFILE ============
    _app.get('/api/profile', async (req, res) => {
      try {
        await ensureDB()
        const userKey = getUserKeyFromReq(req)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        const level = user.level ?? 0
        const maxTierLevel = Object.keys(global.tierAsset.name).length - 1

        // Profile pics rarely change — refetching from WA on every single /api/profile
        // call (with a up-to-4s timeout) is the main cause of slow responses here.
        // Cache the URL for 10 minutes and only hit WA again after it expires.
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
          } catch (_) { /* keep whatever we had cached, if anything */ }
        }

        res.json({
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
            tier: global.tierAsset.name[level] || 'None',
            nextTier: level < maxTierLevel ? global.tierAsset.name[level + 1] : null,
            nextExp: level < maxTierLevel ? global.tierAsset.exp[level + 1] : null,
            premium: user.premium || false,
            premiumTime: user.premiumTime || 0,
            daily: user.daily || 0,
            number: user.number || '',
            lid: user.lid || '',
            spinCount: user.spinCount ?? 0,
            userKey
          }
        })
      } catch (err) {
        console.error('[PROFILE]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ DAILY REWARD ============
    _app.post('/api/daily', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        const now = Date.now()
        const COOLDOWN = 24 * 60 * 60 * 1000

        if (user.daily && (now - user.daily) < COOLDOWN) {
          return res.json({ success: false, message: 'Not yet available.', remaining: user.daily + COOLDOWN - now })
        }

        const expReward = 500
        const gemReward = 5

        user.exp = (user.exp ?? 0) + expReward
        user.gems = (user.gems ?? 0) + gemReward
        user.daily = now
        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({
          success: true,
          exp: user.exp,
          gems: user.gems,
          daily: user.daily,
          expReward,
          gemReward,
          message: `Daily claimed! +${expReward} EXP, +${gemReward} Gems`
        })
      } catch (err) {
        console.error('[DAILY]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ TIER UP ============
    _app.post('/api/tierup', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        const level = user.level ?? 0
        const maxLevel = Object.keys(global.tierAsset.name).length - 1
        if (level >= maxLevel) return res.json({ success: false, message: 'Already MAX TIER!' })

        const needed = global.tierAsset.exp[level + 1]
        if ((user.exp ?? 0) < needed) return res.json({ success: false, message: 'Not enough EXP.', have: user.exp, need: needed })

        const oldTier = global.tierAsset.name[level]
        const newTier = global.tierAsset.name[level + 1]
        user.exp -= needed
        user.level = level + 1
        user.limit = global.tierAsset.limit[level + 1]
        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({ success: true, oldTier, newTier, exp: user.exp, level: user.level, limit: user.limit })
      } catch (err) {
        console.error('[TIER UP]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ CHANGE PASSWORD ============
    _app.post('/api/change-password', changePwLimiter, async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const { oldPassword, newPassword } = req.body
        if (!oldPassword || !newPassword) return res.json({ success: false, message: 'Incomplete data.' })
        if (newPassword.length < 6) return res.json({ success: false, message: 'Password min 6 characters.' })
        if (oldPassword === newPassword) return res.json({ success: false, message: 'New password must be different.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })
        const oldOk = await verifyPassword(oldPassword, user.password)
        if (!oldOk) return res.json({ success: false, message: 'Current password is incorrect.' })

        user.password = await hashPassword(newPassword)
        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({ success: true, message: 'Password updated successfully.' })
      } catch (err) {
        console.error('[change-password]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ RENAME ============
    _app.post('/api/rename', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const { newName } = req.body
        if (!newName || !newName.trim()) return res.json({ success: false, message: 'Name cannot be empty.' })
        if (newName.trim().length > 32) return res.json({ success: false, message: 'Name too long (max 32 chars).' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        user.name = newName.trim()
        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({ success: true, message: 'Name updated!', name: user.name })
      } catch (err) {
        console.error('[RENAME]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ REDEEM GIFT CODE ============
    _app.post('/api/redeem', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        const { code } = req.body
        if (!code || !code.trim()) return res.json({ success: false, message: 'Please enter a code.' })

        const inputCode = code.trim().toUpperCase()
        const botJid = conn.user?.jid || conn.user?.id || ''
        const codes = db.data.settings?.[botJid]?.code
        if (!Array.isArray(codes) || codes.length === 0) {
          return res.json({ success: false, message: 'No gift codes available.' })
        }

        const entry = codes.find(c => c[0].toUpperCase() === inputCode)
        if (!entry) return res.json({ success: false, message: 'Invalid or expired code.' })

        if (!user.redeemedCodes) user.redeemedCodes = []
        if (user.redeemedCodes.includes(inputCode)) {
          return res.json({ success: false, message: 'You have already redeemed this code.' })
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
            if (user.premium && user.premiumTime > now) {
              user.premiumTime = user.premiumTime + days * msPerDay
            } else {
              user.premium = true
              user.premiumTime = now + days * msPerDay
            }
            rewardMessage = `Premium ${days} day${days !== 1 ? 's' : ''}`
            break
          }
          case 'level': {
            const maxLevel = Object.keys(global.tierAsset.name).length - 1
            const newLevel = Math.min(maxLevel, (user.level ?? 0) + rewardNum)
            user.level = newLevel
            user.limit = global.tierAsset.limit[newLevel]
            rewardMessage = `Level → ${global.tierAsset.name[newLevel]}`
            break
          }
          default:
            return res.json({ success: false, message: 'Unknown reward type.' })
        }

        user.redeemedCodes.push(inputCode)
        db.write().catch(err => console.error('[DB WRITE]', err))

        console.log(`[REDEEM] ${user.name} redeemed ${inputCode} → ${rewardMessage}`)
        res.json({
          success: true,
          message: `Code redeemed! Reward: ${rewardMessage}`,
          rewardType, rewardNum, rewardMessage,
          exp: user.exp, limit: user.limit, level: user.level, gems: user.gems
        })
      } catch (err) {
        console.error('[REDEEM]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ BUY LIMIT ============
    _app.post('/api/buy-limit', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        let amount = parseInt(req.body.amount)
        if (isNaN(amount) || amount <= 0) return res.json({ success: false, message: 'Invalid amount.' })

        const currentLevel = user.level ?? 0
        const maxLimit = global.tierAsset.limit[currentLevel] ?? 10
        const remaining = maxLimit - (user.limit ?? 0)

        if (amount > remaining) {
          return res.json({ success: false, message: `Cannot buy more than ${remaining} limit(s). Max limit for your tier: ${maxLimit}` })
        }

        const totalCost = amount * BUY_LIMIT_PRICE
        if ((user.gems ?? 0) < totalCost) {
          return res.json({ success: false, message: `Not enough Gems! Need ${totalCost} Gems.` })
        }

        user.gems -= totalCost
        user.limit = (user.limit ?? 0) + amount
        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({ success: true, message: `Bought ${amount} limit(s)!`, gems: user.gems, limit: user.limit })
      } catch (err) {
        console.error('[BUY LIMIT]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ BUY PREMIUM ============
    _app.post('/api/buy-premium', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        let weeks = parseInt(req.body.weeks)
        if (isNaN(weeks) || weeks <= 0) return res.json({ success: false, message: 'Invalid amount.' })

        const totalCost = weeks * BUY_PREMIUM_PRICE
        if ((user.gems ?? 0) < totalCost) {
          return res.json({ success: false, message: `Not enough Gems! Need ${totalCost} Gems.` })
        }

        user.gems -= totalCost

        const now = Date.now()
        const msPerWeek = 7 * 86400000
        if (user.premium && user.premiumTime > now) {
          user.premiumTime += weeks * msPerWeek
        } else {
          user.premium = true
          user.premiumTime = now + weeks * msPerWeek
        }

        db.write().catch(err => console.error('[DB WRITE]', err))

        res.json({ success: true, message: `Premium extended by ${weeks} week(s)!`, gems: user.gems, premium: user.premium, premiumTime: user.premiumTime })
      } catch (err) {
        console.error('[BUY PREMIUM]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ SLOT GAMBLING ============
    _app.post('/api/slot', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized.' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found.' })

        const currentExp = user.exp ?? 0
        const SPIN_COST = 200
        const PITY_LIMIT = 100
        const SPIN_COOLDOWN = 500

        if (currentExp < SPIN_COST) {
          return res.json({ success: false, message: `Not enough EXP! Need ${SPIN_COST} EXP to spin.` })
        }

        const now = Date.now()
        if (user.lastSpin && (now - user.lastSpin) < SPIN_COOLDOWN) {
          const wait = Math.ceil((SPIN_COOLDOWN - (now - user.lastSpin)) / 1000)
          return res.json({ success: false, message: `Cooldown! Wait ${wait}s before spinning again.` })
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
            case '✦': reward = 200000; winMessage = '💫 ULTRA JACKPOT! ✦✦✦ +200k EXP 💫'; break
            case '7': reward = 77777; winMessage = '🎰 JACKPOT! 7 7 7 +77.7k EXP 🎰'; break
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

        // Respond immediately using the already-updated in-memory data;
        // persist to disk in the background so the user isn't stuck
        // waiting on a full-file JSON write (lowdb rewrites the entire
        // db file on every db.write(), which gets slower as the file
        // grows and can make every spin feel laggy).
        db.write().catch(err => console.error('[SLOT] db.write failed', err))

        console.log(`[SLOT] ${user.name} | ${slots.join(' ')} | expChange: ${expChange}`)
        res.json({
          success: true, slots, reward, cost: SPIN_COST, expChange,
          newExp: user.exp, winMessage, isWin,
          isPity, spinCount: user.spinCount, pityLimit: PITY_LIMIT,
          spinsUntilPity: Math.max(0, PITY_LIMIT - user.spinCount)
        })
      } catch (err) {
        console.error('[SLOT]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ GEMS BALANCE ============
    _app.get('/api/gems', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const userKey = getUserKeyFromToken(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized' })

        const user = db.data.users?.[userKey]
        if (!user) return res.json({ success: false, message: 'User not found' })

        res.json({
          success: true,
          gems: user.gems || 0
        })
      } catch (err) {
        console.error('[GEMS]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ LOGOUT ============
    _app.post('/api/logout', async (req, res) => {
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
        res.json({ success: true })
      } catch (err) {
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ CHECK OWNER ============
    _app.get('/api/check-owner', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey, isOwner } = checkOwner(token)
        if (!userKey) return res.json({ success: false, isOwner: false })
        res.json({ success: true, isOwner })
      } catch (err) {
        res.json({ success: false, isOwner: false })
      }
    })

    // ============ ADMIN - GIFT CODES ============
    _app.get('/api/admin/giftcodes', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey, isOwner } = checkOwner(token)
        if (!userKey || !isOwner) return res.json({ success: false, message: 'Forbidden' })

        const botJid = conn.user?.jid || conn.user?.id || ''
        const codes = db.data.settings?.[botJid]?.code || []
        res.json({ success: true, codes })
      } catch (err) {
        console.error('[ADMIN/GIFTCODES GET]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    _app.post('/api/admin/giftcodes/add', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey, isOwner } = checkOwner(token)
        if (!userKey || !isOwner) return res.json({ success: false, message: 'Forbidden' })

        const { code, reward } = req.body
        if (!code || !reward) return res.json({ success: false, message: 'Invalid data' })

        const botJid = conn.user?.jid || conn.user?.id || ''
        if (!db.data.settings) db.data.settings = {}
        if (!db.data.settings[botJid]) db.data.settings[botJid] = {}
        if (!Array.isArray(db.data.settings[botJid].code)) db.data.settings[botJid].code = []

        const codes = db.data.settings[botJid].code
        const upperCode = code.trim().toUpperCase()
        if (codes.find(c => c[0].toUpperCase() === upperCode)) {
          return res.json({ success: false, message: 'Code already exists.' })
        }

        codes.push([upperCode, reward.trim()])
        db.write().catch(err => console.error('[DB WRITE]', err))
        console.log(`[ADMIN/GIFTCODES] Added: ${upperCode} → ${reward}`)
        res.json({ success: true, codes })
      } catch (err) {
        console.error('[ADMIN/GIFTCODES ADD]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    _app.post('/api/admin/giftcodes/delete', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey, isOwner } = checkOwner(token)
        if (!userKey || !isOwner) return res.json({ success: false, message: 'Forbidden' })

        const { code } = req.body
        if (!code) return res.json({ success: false, message: 'Invalid data' })

        const botJid = conn.user?.jid || conn.user?.id || ''
        const codes = db.data.settings?.[botJid]?.code
        if (!Array.isArray(codes)) return res.json({ success: false, message: 'No codes found.' })

        const upperCode = code.trim().toUpperCase()
        const idx = codes.findIndex(c => c[0].toUpperCase() === upperCode)
        if (idx === -1) return res.json({ success: false, message: 'Code not found.' })

        codes.splice(idx, 1)
        db.write().catch(err => console.error('[DB WRITE]', err))
        console.log(`[ADMIN/GIFTCODES] Deleted: ${upperCode}`)
        res.json({ success: true, codes })
      } catch (err) {
        console.error('[ADMIN/GIFTCODES DELETE]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ ADMIN - USERS ============
    _app.get('/api/admin/users', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey, isOwner } = checkOwner(token)
        if (!userKey) return res.json({ success: false, message: 'Unauthorized' })
        if (!isOwner) return res.json({ success: false, message: 'Forbidden' })

        const users = Object.entries(db.data.users || {})
          .filter(([key]) => !key.endsWith('@g.us'))
          .map(([key, val]) => ({ userKey: key, ...val }))

        res.json({ success: true, users })
      } catch (err) {
        console.error('[ADMIN/USERS]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    _app.post('/api/admin/update-user', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey: callerKey, isOwner } = checkOwner(token)
        if (!callerKey) return res.json({ success: false, message: 'Unauthorized' })
        if (!isOwner) return res.json({ success: false, message: 'Forbidden' })

        const { userKey: targetKey, field, value } = req.body
        if (!targetKey || !field) return res.json({ success: false, message: 'Invalid data' })
        if (!db.data.users[targetKey]) return res.json({ success: false, message: 'User not found' })

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
        console.log(`[ADMIN/UPDATE-USER] ${db.data.users[callerKey].name} updated ${db.data.users[targetKey].name}'s ${field} = ${value}`)
        res.json({ success: true, message: 'Updated', userKey: targetKey, field, value: user[field] })
      } catch (err) {
        console.error('[ADMIN/UPDATE-USER]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    _app.post('/api/admin/delete-user', async (req, res) => {
      try {
        await ensureDB()
        const token = getToken(req)
        const { userKey: callerKey, isOwner } = checkOwner(token)
        if (!callerKey) return res.json({ success: false, message: 'Unauthorized' })
        if (!isOwner) return res.json({ success: false, message: 'Forbidden' })

        const { userKey: targetKey } = req.body
        if (!targetKey) return res.json({ success: false, message: 'Invalid data' })
        if (!db.data.users[targetKey]) return res.json({ success: false, message: 'User not found' })

        delete db.data.users[targetKey]
        db.write().catch(err => console.error('[DB WRITE]', err))

        console.log(`[admin/delete-user] ${callerKey} deleted ${targetKey}`)
        res.json({ success: true, message: 'User deleted' })
      } catch (err) {
        console.error('[admin/delete-user]', err)
        res.json({ success: false, message: 'Internal error' })
      }
    })

    // ============ CHECK NUMBER ============
    _app.post('/api/check-number', async (req, res) => {
      try {
        await ensureDB()
        const { phone } = req.body
        if (!phone) return res.json({ exists: false })
        const targetKey = normalizePhone(phone) + '@s.whatsapp.net'
        res.json({ exists: !!db.data.users?.[targetKey] })
      } catch (err) {
        console.error('[check-number]', err)
        res.json({ exists: false })
      }
    })

    // ============ GLOBAL ERROR HANDLER ============
    _app.use((err, req, res, next) => {
      console.error('Server ', err?.message)
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Internal error' })
    })

    // ============ SOCKET.IO ============
    _io = new Server(_server, { pingTimeout: 60000, pingInterval: 25000, transports: ['websocket', 'polling'], allowEIO3: true })
    _io.on('connection', socket => {
      console.log('[socket] Connected:', socket.id)
      socket.on('disconnect', reason => console.log('[socket] Disconnected:', socket.id, reason))
      socket.on('error', err => console.error('• [ Socket ] Error:', err.message))
      const { unpipeEmit } = pipeEmit(conn, socket, 'conn-')
      socket.once('disconnect', unpipeEmit)
    })

    _server.listen(PORT, '0.0.0.0', () => console.log(chalk.yellow('Server') + chalk.gray(' Listening on port ' + PORT)))
  }

  if (_unpipe) _unpipe()
  if (_io) {
    const { unpipeEmit } = pipeEmit(conn, _io, 'conn-')
    _unpipe = unpipeEmit
  }

  return _server
}

export default connect