import Helper from './helper.js'
import chalk from './color.js'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_INSTALL_ATTEMPTS = 3
const INSTALL_TIMEOUT_MS = 120_000
const VERIFY_POLL_ATTEMPTS = 10
const VERIFY_POLL_DELAY_MS = 300

const sleep = ms => new Promise(r => setTimeout(r, ms))

let cachedProjectRoot = null

async function findProjectRoot() {
  if (cachedProjectRoot) return cachedProjectRoot
  const { fileURLToPath } = await import('url')
  const path = await import('path')
  const fs = await import('fs')

  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedProjectRoot = dir
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      cachedProjectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
      return cachedProjectRoot
    }
    dir = parent
  }
}

function createLazyLoader(pkgName, onLoaded) {
  let loaded = null
  let loading = null
  let hardFailure = null

  const pkgRootName = pkgName.split('/')[0]

  async function findEntryFile(projectRoot) {
    const fs = await import('fs')
    const path = await import('path')
    const pkgDir = path.join(projectRoot, 'node_modules', pkgName)
    const pkgJsonPath = path.join(pkgDir, 'package.json')

    if (!fs.existsSync(pkgJsonPath)) return null

    let pkgJson
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    } catch {
      return null
    }

    const candidates = []
    if (typeof pkgJson.exports === 'string') candidates.push(pkgJson.exports)
    else if (pkgJson.exports && typeof pkgJson.exports === 'object') {
      const root = pkgJson.exports['.'] ?? pkgJson.exports
      if (typeof root === 'string') candidates.push(root)
      else if (root && typeof root === 'object') {
        candidates.push(root.import?.default || root.import, root.require?.default || root.require, root.default)
      }
    }
    if (pkgJson.module) candidates.push(pkgJson.module)
    if (pkgJson.main) candidates.push(pkgJson.main)
    candidates.push('index.js', 'lib/index.js')

    for (const rel of candidates) {
      if (!rel) continue
      const full = path.join(pkgDir, rel)
      if (fs.existsSync(full)) return full
    }
    return null
  }

  async function isPresent() {
    const projectRoot = await findProjectRoot()
    return !!(await findEntryFile(projectRoot))
  }

  async function doImport() {
    const { pathToFileURL } = await import('url')
    const projectRoot = await findProjectRoot()
    const entryFile = await findEntryFile(projectRoot)
    if (!entryFile) throw new Error(`${pkgName} package files not found on disk`)
    return onLoaded(await import(pathToFileURL(entryFile).href))
  }

  async function runNpmInstall() {
    const { spawn } = await import('child_process')
    const projectRoot = await findProjectRoot()

    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['i', pkgName, '--no-save', '--no-audit', '--no-fund'], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let output = ''
      child.stdout?.on('data', chunk => { output += chunk })
      child.stderr?.on('data', chunk => { output += chunk })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`npm timed out after ${INSTALL_TIMEOUT_MS / 1000}s`))
      }, INSTALL_TIMEOUT_MS)

      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })

      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) return resolve(output)
        reject(new Error(`npm exited with code ${code}\n${output.trim()}`))
      })
    })
  }

  async function removePackageDir() {
    const { rmSync } = await import('fs')
    const path = await import('path')
    const projectRoot = await findProjectRoot()
    rmSync(path.join(projectRoot, 'node_modules', pkgRootName), { recursive: true, force: true })
  }

  async function installAndWaitUntilPresent(attempt) {
    console.log(chalk.red('[ DB ]') + chalk.gray(` ${pkgName} not found, installing (attempt ${attempt}/${MAX_INSTALL_ATTEMPTS})...`))

    if (attempt > 1) await removePackageDir()

    let npmOutput = ''
    try {
      npmOutput = await runNpmInstall()
    } catch (err) {
      throw new Error(`npm install failed: ${err?.message || err}`)
    }

    for (let i = 0; i < VERIFY_POLL_ATTEMPTS; i++) {
      if (await isPresent()) {
        console.log(chalk.green('[ DB ]') + chalk.gray(` ${pkgName} verified on disk after install`))
        return
      }
      await sleep(VERIFY_POLL_DELAY_MS)
    }

    throw new Error(
      `npm reported success but ${pkgName} still isn't resolvable on disk after ` +
      `${(VERIFY_POLL_ATTEMPTS * VERIFY_POLL_DELAY_MS) / 1000}s of polling ` +
      `(possible broken/partial package from this host's npm registry).\n${npmOutput.trim().slice(-800)}`
    )
  }

  return async function load() {
    if (loaded) return loaded
    if (hardFailure) throw hardFailure
    if (loading) return loading

    loading = (async () => {
      if (await isPresent()) {
        console.log(chalk.gray(`[ DB ] ${pkgName} already present, loading...`))
        return (loaded = await doImport())
      }

      let lastErr = null
      for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt++) {
        try {
          await installAndWaitUntilPresent(attempt)
          const result = (loaded = await doImport())
          console.log(chalk.green('[ DB ]') + chalk.gray(` ${pkgName} installed & loaded successfully`))
          return result
        } catch (err) {
          lastErr = err
          console.log(chalk.yellow('[ DB ]') + chalk.gray(` ${pkgName} attempt ${attempt} failed: ${err?.message || err}`))
        }
      }

      loading = null
      hardFailure = new Error(
        `${pkgName} could not be installed after ${MAX_INSTALL_ATTEMPTS} attempt(s): ${lastErr?.message || lastErr}\n` +
        `Consider adding "${pkgName}" to package.json dependencies so it's installed at deploy time instead of at runtime, ` +
        `or check npm/network access on this host.`
      )
      throw hardFailure
    })()

    return loading
  }
}

const loadMysql = createLazyLoader('mysql2/promise', mod => mod.default)

let _oidCounter = randomBytes(3).readUIntBE(0, 3)
const _oidProcess = randomBytes(5)

class ObjectId {
  constructor(id) {
    if (id === undefined || id === null) {
      const b = Buffer.alloc(12)
      b.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0)
      _oidProcess.copy(b, 4)
      _oidCounter = (_oidCounter + 1) & 0xffffff
      b.writeUIntBE(_oidCounter, 9, 3)
      this.buffer = b
    } else if (id instanceof ObjectId) {
      this.buffer = Buffer.from(id.buffer)
    } else if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) {
      this.buffer = Buffer.from(id, 'hex')
    } else if (Buffer.isBuffer(id) && id.length === 12) {
      this.buffer = Buffer.from(id)
    } else {
      throw new TypeError('ObjectId must be a 24-char hex string or 12-byte Buffer')
    }
  }
  toHexString() { return this.buffer.toString('hex') }
  toString() { return this.toHexString() }
  toJSON() { return this.toHexString() }
  equals(other) {
    if (other instanceof ObjectId) return this.buffer.equals(other.buffer)
    if (typeof other === 'string') return this.toHexString() === other.toLowerCase()
    return false
  }
  getTimestamp() { return new Date(this.buffer.readUInt32BE(0) * 1000) }
  get [Symbol.toStringTag]() { return 'ObjectId' }
}

class BsonInt32 { constructor(v) { this.value = v | 0 } valueOf() { return this.value } }
class BsonDouble { constructor(v) { this.value = Number(v) } valueOf() { return this.value } }
class BsonLong {
  constructor(v) { this.value = BigInt(v) }
  valueOf() { return this.value }
  toNumber() { return Number(this.value) }
  toString() { return this.value.toString() }
}
class BsonTimestamp {
  constructor(t, i) { this.t = t >>> 0; this.i = i >>> 0 }
}
class BsonBinary {
  constructor(buffer, subType = 0) { this.buffer = Buffer.from(buffer); this.subType = subType }
}
class BsonDecimal128 { constructor(bytes) { this.bytes = Buffer.from(bytes) } }
class BsonMinKey {}
class BsonMaxKey {}

const INT32_MIN = -0x80000000
const INT32_MAX = 0x7fffffff

function bsonCString(str) {
  if (str.includes('\0')) throw new Error('BSON key/bsonCString may not contain NUL')
  return Buffer.concat([Buffer.from(str, 'utf8'), Buffer.from([0])])
}

function bsonEncodeString(str) {
  const body = Buffer.from(str, 'utf8')
  const out = Buffer.alloc(4 + body.length + 1)
  out.writeInt32LE(body.length + 1, 0)
  body.copy(out, 4)
  return out
}

function bsonEncodeValue(value, ignoreUndefined) {
  if (value === undefined) return ignoreUndefined ? null : [0x0a, Buffer.alloc(0)]
  if (value === null) return [0x0a, Buffer.alloc(0)]

  switch (typeof value) {
    case 'string':
      return [0x02, bsonEncodeString(value)]
    case 'boolean':
      return [0x08, Buffer.from([value ? 1 : 0])]
    case 'number': {
      if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX && !Object.is(value, -0)) {
        const b = Buffer.alloc(4)
        b.writeInt32LE(value, 0)
        return [0x10, b]
      }
      const b = Buffer.alloc(8)
      b.writeDoubleLE(value, 0)
      return [0x01, b]
    }
    case 'bigint': {
      const b = Buffer.alloc(8)
      b.writeBigInt64LE(BigInt.asIntN(64, value), 0)
      return [0x12, b]
    }
    case 'function':
    case 'symbol':
      return null
  }

  if (value instanceof Date) {
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(BigInt(value.getTime()), 0)
    return [0x09, b]
  }
  if (value instanceof ObjectId) return [0x07, value.buffer]
  if (value instanceof BsonInt32) {
    const b = Buffer.alloc(4); b.writeInt32LE(value.value, 0); return [0x10, b]
  }
  if (value instanceof BsonDouble) {
    const b = Buffer.alloc(8); b.writeDoubleLE(value.value, 0); return [0x01, b]
  }
  if (value instanceof BsonLong) {
    const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt.asIntN(64, value.value), 0); return [0x12, b]
  }
  if (value instanceof BsonTimestamp) {
    const b = Buffer.alloc(8); b.writeUInt32LE(value.i, 0); b.writeUInt32LE(value.t, 4); return [0x11, b]
  }
  if (value instanceof BsonDecimal128) return [0x13, value.bytes]
  if (value instanceof BsonMinKey) return [0xff, Buffer.alloc(0)]
  if (value instanceof BsonMaxKey) return [0x7f, Buffer.alloc(0)]
  if (value instanceof RegExp) {
    let flags = ''
    if (value.ignoreCase) flags += 'i'
    if (value.multiline) flags += 'm'
    if (value.dotAll) flags += 's'
    if (value.unicode) flags += 'u'
    return [0x0b, Buffer.concat([bsonCString(value.source), bsonCString(flags)])]
  }
  if (value instanceof BsonBinary || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = value instanceof BsonBinary ? value.buffer : Buffer.from(value.buffer ? value : value)
    const sub = value instanceof BsonBinary ? value.subType : 0
    const b = Buffer.alloc(5 + data.length)
    b.writeInt32LE(data.length, 0)
    b[4] = sub
    data.copy(b, 5)
    return [0x05, b]
  }
  if (Array.isArray(value)) return [0x04, bsonSerializeArray(value, ignoreUndefined)]

  if (typeof value.toBSON === 'function') return bsonEncodeValue(value.toBSON(), ignoreUndefined)
  return [0x03, bsonSerialize(value, { ignoreUndefined })]
}

function bsonSerializeArray(arr, ignoreUndefined) {
  const parts = []
  for (let i = 0; i < arr.length; i++) {
    const enc = bsonEncodeValue(arr[i], ignoreUndefined)
    const [type, buf] = enc || [0x0a, Buffer.alloc(0)]
    parts.push(Buffer.from([type]), bsonCString(String(i)), buf)
  }
  return bsonWrapDocument(parts)
}

function bsonWrapDocument(parts) {
  const body = Buffer.concat(parts)
  const out = Buffer.alloc(4 + body.length + 1)
  out.writeInt32LE(out.length, 0)
  body.copy(out, 4)
  return out
}

function bsonSerialize(doc, { ignoreUndefined = true } = {}) {
  if (doc === null || typeof doc !== 'object') throw new TypeError('BSON bsonSerialize expects an object')
  if (Array.isArray(doc)) return bsonSerializeArray(doc, ignoreUndefined)
  const parts = []
  for (const key of Object.keys(doc)) {
    const enc = bsonEncodeValue(doc[key], ignoreUndefined)
    if (!enc) continue
    parts.push(Buffer.from([enc[0]]), bsonCString(key), enc[1])
  }
  return bsonWrapDocument(parts)
}

function bsonReadCString(buf, offset) {
  const end = buf.indexOf(0, offset)
  if (end === -1) throw new Error('BSON: unterminated bsonCString')
  return [buf.toString('utf8', offset, end), end + 1]
}

function bsonDecodeValue(type, buf, offset, opts) {
  switch (type) {
    case 0x01: return [buf.readDoubleLE(offset), offset + 8]
    case 0x02: {
      const len = buf.readInt32LE(offset)
      return [buf.toString('utf8', offset + 4, offset + 4 + len - 1), offset + 4 + len]
    }
    case 0x03: {
      const size = buf.readInt32LE(offset)
      return [bsonDeserialize(buf, opts, offset), offset + size]
    }
    case 0x04: {
      const size = buf.readInt32LE(offset)
      const obj = bsonDeserialize(buf, opts, offset)
      return [Object.keys(obj).sort((a, b) => a - b).map(k => obj[k]), offset + size]
    }
    case 0x05: {
      const len = buf.readInt32LE(offset)
      const sub = buf[offset + 4]
      let data = Buffer.from(buf.subarray(offset + 5, offset + 5 + len))
      if (sub === 2) data = data.subarray(4)
      return [sub === 0 && !opts.keepBinary ? data : new BsonBinary(data, sub), offset + 5 + len]
    }
    case 0x06: return [undefined, offset]
    case 0x07: return [new ObjectId(Buffer.from(buf.subarray(offset, offset + 12))), offset + 12]
    case 0x08: return [buf[offset] === 1, offset + 1]
    case 0x09: return [new Date(Number(buf.readBigInt64LE(offset))), offset + 8]
    case 0x0a: return [null, offset]
    case 0x0b: {
      const [source, o1] = bsonReadCString(buf, offset)
      const [flags, o2] = bsonReadCString(buf, o1)
      let jsFlags = ''
      for (const f of flags) if ('imsu'.includes(f) && !jsFlags.includes(f)) jsFlags += f
      return [new RegExp(source, jsFlags), o2]
    }
    case 0x0d: {
      const len = buf.readInt32LE(offset)
      return [buf.toString('utf8', offset + 4, offset + 4 + len - 1), offset + 4 + len]
    }
    case 0x0e: {
      const len = buf.readInt32LE(offset)
      return [buf.toString('utf8', offset + 4, offset + 4 + len - 1), offset + 4 + len]
    }
    case 0x10: return [buf.readInt32LE(offset), offset + 4]
    case 0x11: return [new BsonTimestamp(buf.readUInt32LE(offset + 4), buf.readUInt32LE(offset)), offset + 8]
    case 0x12: {
      const big = buf.readBigInt64LE(offset)
      const asNum = Number(big)
      const value = opts.promoteLongs !== false && Number.isSafeInteger(asNum) ? asNum : big
      return [value, offset + 8]
    }
    case 0x13: return [new BsonDecimal128(Buffer.from(buf.subarray(offset, offset + 16))), offset + 16]
    case 0xff: return [new BsonMinKey(), offset]
    case 0x7f: return [new BsonMaxKey(), offset]
    default:
      throw new Error(`BSON: unsupported element type 0x${type.toString(16)}`)
  }
}

function bsonDeserialize(buf, opts = {}, start = 0) {
  const size = buf.readInt32LE(start)
  if (size < 5 || start + size > buf.length) throw new Error('BSON: invalid document size')
  const end = start + size - 1
  if (buf[end] !== 0) throw new Error('BSON: missing document terminator')

  const out = {}
  let offset = start + 4
  while (offset < end) {
    const type = buf[offset++]
    if (type === 0) break
    let key
    ;[key, offset] = bsonReadCString(buf, offset)
    let value
    ;[value, offset] = bsonDecodeValue(type, buf, offset, opts)
    if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    else out[key] = value
  }
  return out
}

function bsonDeserializeStream(buf, opts = {}) {
  const docs = []
  let offset = 0
  while (offset < buf.length) {
    const size = buf.readInt32LE(offset)
    docs.push(bsonDeserialize(buf, opts, offset))
    offset += size
  }
  return docs
}

const SCRAM_MECHANISMS = {
  'SCRAM-SHA-256': { hash: 'sha256', keyLen: 32 },
  'SCRAM-SHA-1': { hash: 'sha1', keyLen: 20 },
}

const scramHmac = (alg, key, data) => createHmac(alg, key).update(data).digest()
const scramDigest = (alg, data) => createHash(alg).update(data).digest()
const scramXor = (a, b) => {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

const saslName = s => s.replace(/=/g, '=3D').replace(/,/g, '=2C')

function saslPrep(input) {
  if (/^[\x20-\x7e]*$/.test(input)) return input
  let s = input.normalize('NFKC')
  s = s.replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
  s = s.replace(/[\u00ad\u034f\u1806\u180b-\u180d\u200c\u200d\u2060\ufe00-\ufe0f\ufeff]/g, '')
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) throw new Error('SASLprep: prohibited character in password')
  return s
}

function mongoSha1Password(user, password) {
  return createHash('md5').update(`${user}:mongo:${password}`, 'utf8').digest('hex')
}

function parseScramMessage(msg) {
  const out = {}
  for (const part of msg.split(',')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

class ScramClient {
  constructor({ mechanism = 'SCRAM-SHA-256', username, password, nonce } = {}) {
    const m = SCRAM_MECHANISMS[mechanism]
    if (!m) throw new Error(`Unsupported SCRAM mechanism: ${mechanism}`)
    this.mechanism = mechanism
    this.alg = m.hash
    this.keyLen = m.keyLen
    this.username = username
    this.password = password
    this.nonce = nonce || randomBytes(24).toString('base64')
    this.clientFirstBare = `n=${saslName(username)},r=${this.nonce}`
    this.serverSignature = null
  }

  clientFirst() {
    return Buffer.from(`n,,${this.clientFirstBare}`, 'utf8')
  }

  clientFinal(serverFirstBuf) {
    const serverFirst = Buffer.from(serverFirstBuf).toString('utf8')
    const p = parseScramMessage(serverFirst)
    if (!p.r || !p.s || !p.i) throw new Error('SCRAM: malformed server-first message')
    if (!p.r.startsWith(this.nonce)) throw new Error('SCRAM: server nonce does not extend client nonce')

    const iterations = parseInt(p.i, 10)
    if (!Number.isInteger(iterations) || iterations < 4096) {
      throw new Error(`SCRAM: iteration count ${p.i} is too low`)
    }

    const salt = Buffer.from(p.s, 'base64')
    const pass = this.mechanism === 'SCRAM-SHA-256'
      ? saslPrep(this.password)
      : mongoSha1Password(this.username, this.password)

    const salted = pbkdf2Sync(pass, salt, iterations, this.keyLen, this.alg)
    const clientKey = scramHmac(this.alg, salted, 'Client Key')
    const storedKey = scramDigest(this.alg, clientKey)
    const clientFinalNoProof = `c=biws,r=${p.r}`
    const authMessage = `${this.clientFirstBare},${serverFirst},${clientFinalNoProof}`
    const clientSignature = scramHmac(this.alg, storedKey, authMessage)
    const proof = scramXor(clientKey, clientSignature)

    const serverKey = scramHmac(this.alg, salted, 'Server Key')
    this.serverSignature = scramHmac(this.alg, serverKey, authMessage)

    return Buffer.from(`${clientFinalNoProof},p=${proof.toString('base64')}`, 'utf8')
  }

  verifyServerFinal(serverFinalBuf) {
    const p = parseScramMessage(Buffer.from(serverFinalBuf).toString('utf8'))
    if (p.e) throw new Error(`SCRAM: server error: ${p.e}`)
    if (!p.v) throw new Error('SCRAM: server-final missing verifier')
    const got = Buffer.from(p.v, 'base64')
    if (got.length !== this.serverSignature.length || !timingSafeEqual(got, this.serverSignature)) {
      throw new Error('SCRAM: server signature mismatch (server could not prove it knows the password)')
    }
    return true
  }
}

const dnsResolveSrv = dns.promises.resolveSrv.bind(dns.promises)
const dnsResolveTxt = dns.promises.resolveTxt.bind(dns.promises)

const uriBool = v => {
  const s = String(v).toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  throw new Error(`Invalid boolean value: ${v}`)
}
const uriInt = v => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid integer value: ${v}`)
  return n
}
const URI_OPTIONS = {
  replicaset: ['replicaSet', String],
  tls: ['tls', uriBool],
  ssl: ['tls', uriBool],
  tlsallowinvalidcertificates: ['tlsAllowInvalidCertificates', uriBool],
  tlsallowinvalidhostnames: ['tlsAllowInvalidHostnames', uriBool],
  tlscafile: ['tlsCAFile', String],
  tlscertificatekeyfile: ['tlsCertificateKeyFile', String],
  authsource: ['authSource', String],
  authmechanism: ['authMechanism', String],
  appname: ['appName', String],
  directconnection: ['directConnection', uriBool],
  connecttimeoutms: ['connectTimeoutMS', uriInt],
  sockettimeoutms: ['socketTimeoutMS', uriInt],
  serverselectiontimeoutms: ['serverSelectionTimeoutMS', uriInt],
  maxpoolsize: ['maxPoolSize', uriInt],
  minpoolsize: ['minPoolSize', uriInt],
  retrywrites: ['retryWrites', uriBool],
  retryreads: ['retryReads', uriBool],
  w: ['w', v => (/^\d+$/.test(v) ? Number(v) : String(v))],
  wtimeoutms: ['wtimeoutMS', uriInt],
  journal: ['journal', uriBool],
  readpreference: ['readPreference', String],
  compressors: ['compressors', String],
  loadbalanced: ['loadBalanced', uriBool],
}

function uriDecode(s, what) {
  try { return decodeURIComponent(s) } catch { throw new Error(`Invalid percent-encoding in ${what}`) }
}

function uriParseHostList(list, isSrv) {
  const hosts = []
  for (const raw of list.split(',')) {
    if (!raw) throw new Error('Invalid connection string: empty host')
    let host, port
    if (raw.startsWith('[')) {
      const end = raw.indexOf(']')
      if (end === -1) throw new Error(`Invalid IPv6 host: ${raw}`)
      host = raw.slice(1, end)
      const rest = raw.slice(end + 1)
      if (rest) {
        if (!rest.startsWith(':')) throw new Error(`Invalid host: ${raw}`)
        port = rest.slice(1)
      }
    } else if (raw.endsWith('.sock')) {
      throw new Error('Unix domain sockets are not supported')
    } else {
      const i = raw.lastIndexOf(':')
      if (i === -1) host = raw
      else { host = raw.slice(0, i); port = raw.slice(i + 1) }
    }
    if (!host) throw new Error(`Invalid host: ${raw}`)
    if (port !== undefined) {
      if (isSrv) throw new Error('mongodb+srv:// URIs must not specify a port')
      const n = Number(port)
      if (!/^\d+$/.test(port) || n < 1 || n > 65535) throw new Error(`Invalid port: ${port}`)
      port = n
    }
    hosts.push({ host: host.toLowerCase(), port: port ?? 27017 })
  }
  return hosts
}

function uriParseQuery(query, into = {}) {
  if (!query) return into
  for (const pair of query.split('&')) {
    if (!pair) continue
    const i = pair.indexOf('=')
    const rawKey = uriDecode(i === -1 ? pair : pair.slice(0, i), 'option name')
    const rawVal = i === -1 ? '' : uriDecode(pair.slice(i + 1), `option ${rawKey}`)
    const spec = URI_OPTIONS[rawKey.toLowerCase()]
    if (spec) into[spec[0]] = spec[1](rawVal)
    else (into.extra ||= {})[rawKey] = rawVal
  }
  return into
}

function parseUri(uri) {
  if (typeof uri !== 'string') throw new TypeError('Connection string must be a string')
  const m = uri.match(/^(mongodb(?:\+srv)?):\/\/(.*)$/is)
  if (!m) throw new Error('Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"')
  const srv = m[1].toLowerCase() === 'mongodb+srv'
  let rest = m[2]

  let query = ''
  const q = rest.indexOf('?')
  if (q !== -1) { query = rest.slice(q + 1); rest = rest.slice(0, q) }

  let dbName = ''
  const slash = rest.indexOf('/')
  let authority = rest
  if (slash !== -1) { authority = rest.slice(0, slash); dbName = uriDecode(rest.slice(slash + 1), 'database name') }
  else if (query && !rest) throw new Error('Invalid connection string: missing hosts')

  let username, password
  const at = authority.lastIndexOf('@')
  let hostPart = authority
  if (at !== -1) {
    const cred = authority.slice(0, at)
    hostPart = authority.slice(at + 1)
    const colon = cred.indexOf(':')
    if (/[@/]/.test(colon === -1 ? cred : cred.slice(colon + 1)) && cred.includes('@'))
      throw new Error('Username and password must be percent-encoded ("@", ":" and "/" are reserved)')
    username = uriDecode(colon === -1 ? cred : cred.slice(0, colon), 'username')
    password = colon === -1 ? undefined : uriDecode(cred.slice(colon + 1), 'password')
    if (!username) throw new Error('Invalid connection string: empty username')
  }

  if (!hostPart) throw new Error('Invalid connection string: missing hosts')
  const hosts = uriParseHostList(hostPart, srv)
  if (srv && hosts.length !== 1) throw new Error('mongodb+srv:// URIs must contain exactly one host')
  if (srv && hosts[0].host.split('.').length < 3)
    throw new Error('mongodb+srv:// hostname must have at least three parts (e.g. cluster0.abcde.mongodb.net)')

  const options = uriParseQuery(query)
  if (srv) options.tls ??= true

  return { srv, srvHost: srv ? hosts[0].host : undefined, hosts: srv ? [] : hosts, username, password, dbName: dbName || 'test', hasDbName: !!dbName, options }
}

async function resolveSrvUri(parsed, { resolver = { resolveSrv: dnsResolveSrv, resolveTxt: dnsResolveTxt } } = {}) {
  if (!parsed.srv) return parsed

  const name = parsed.srvHost
  const records = await resolver.resolveSrv(`_mongodb._tcp.${name}`)
  if (!records?.length) throw new Error(`No SRV records found for _mongodb._tcp.${name}`)

  const parent = name.split('.').slice(1).join('.')
  const hosts = records.map(r => {
    const target = r.name.replace(/\.$/, '').toLowerCase()
    if (!(target === parent || target.endsWith('.' + parent)))
      throw new Error(`SRV target "${target}" is not within parent domain "${parent}"`)
    return { host: target, port: r.port }
  })

  let txtOpts = {}
  try {
    const txt = await resolver.resolveTxt(name)
    if (txt.length > 1) throw new Error('Multiple TXT records found; only one is allowed')
    if (txt.length === 1) {
      const raw = uriParseQuery(txt[0].join(''))
      for (const k of Object.keys(raw)) {
        if (!['authSource', 'replicaSet', 'loadBalanced'].includes(k))
          throw new Error(`TXT record may only set authSource, replicaSet, loadBalanced (got ${k})`)
      }
      txtOpts = raw
    }
  } catch (err) {
    if (!['ENODATA', 'ENOTFOUND'].includes(err.code)) throw err
  }

  return { ...parsed, hosts, options: { ...txtOpts, ...parsed.options } }
}

async function resolveUri(uri, opts) {
  return resolveSrvUri(parseUri(uri), opts)
}

const WIRE_OP_MSG = 2013
const WIRE_OP_COMPRESSED = 2012
const WIRE_HEADER_LEN = 16
const WIRE_CHECKSUM_PRESENT = 1 << 0
const WIRE_MORE_TO_COME = 1 << 1
const WIRE_MAX_MESSAGE_SIZE = 48_000_000

class MongoError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'MongoError'
    Object.assign(this, extra)
  }
}
class MongoNetworkError extends MongoError {
  constructor(message, extra) { super(message, extra); this.name = 'MongoNetworkError' }
}
class MongoServerError extends MongoError {
  constructor(doc) {
    super(doc.errmsg || doc.$err || 'Unknown server error')
    this.name = 'MongoServerError'
    this.code = doc.code
    this.codeName = doc.codeName
    this.errorLabels = doc.errorLabels || []
    this.result = doc
  }
}

function wireStripChecksum(body, flags) {
  return flags & WIRE_CHECKSUM_PRESENT ? body.subarray(0, body.length - 4) : body
}

let wireRequestCounter = 0
const wireNextRequestId = () => (wireRequestCounter = (wireRequestCounter + 1) & 0x7fffffff) || 1

function encodeOpMsg(command, requestId, { responseTo = 0, flags = 0, documentSequences = [] } = {}) {
  const body = bsonSerialize(command)
  const parts = []
  const flagBuf = Buffer.alloc(4); flagBuf.writeUInt32LE(flags, 0)
  parts.push(flagBuf, Buffer.from([0]), body)

  for (const { identifier, documents } of documentSequences) {
    const docs = Buffer.concat(documents.map(d => bsonSerialize(d)))
    const id = Buffer.from(identifier + '\0', 'utf8')
    const size = Buffer.alloc(4); size.writeInt32LE(4 + id.length + docs.length, 0)
    parts.push(Buffer.from([1]), size, id, docs)
  }

  const payload = Buffer.concat(parts)
  const header = Buffer.alloc(WIRE_HEADER_LEN)
  header.writeInt32LE(WIRE_HEADER_LEN + payload.length, 0)
  header.writeInt32LE(requestId, 4)
  header.writeInt32LE(responseTo, 8)
  header.writeInt32LE(WIRE_OP_MSG, 12)
  return Buffer.concat([header, payload])
}

function decodeOpMsg(payload, bsonOpts) {
  const flags = payload.readUInt32LE(0)
  const body = wireStripChecksum(payload.subarray(4), flags)
  let offset = 0
  let doc = null
  const sequences = {}
  while (offset < body.length) {
    const kind = body[offset++]
    if (kind === 0) {
      const size = body.readInt32LE(offset)
      doc = bsonDeserialize(body, bsonOpts, offset)
      offset += size
    } else if (kind === 1) {
      const size = body.readInt32LE(offset)
      const end = offset + size
      let p = offset + 4
      const idEnd = body.indexOf(0, p)
      const ident = body.toString('utf8', p, idEnd)
      p = idEnd + 1
      sequences[ident] = bsonDeserializeStream(body.subarray(p, end), bsonOpts)
      offset = end
    } else {
      throw new MongoError(`Unknown WIRE_OP_MSG section kind ${kind}`)
    }
  }
  if (!doc) throw new MongoError('WIRE_OP_MSG reply had no body section')
  return { doc, sequences, flags }
}

class Connection extends EventEmitter {
  constructor({ host, port, tls: useTls = false, tlsOptions = {}, connectTimeoutMS = 30000, socketTimeoutMS = 0, appName, bsonOptions = {} }) {
    super()
    this.host = host
    this.port = port
    this.useTls = useTls
    this.tlsOptions = tlsOptions
    this.connectTimeoutMS = connectTimeoutMS
    this.socketTimeoutMS = socketTimeoutMS
    this.appName = appName
    this.bsonOptions = bsonOptions
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.closed = false
    this.hello = null
    this.address = `${host}:${port}`
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = err => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        this.socket?.destroy()
        reject(err instanceof MongoError ? err : new MongoNetworkError(`connect to ${this.address} failed: ${err.message}`, { cause: err }))
      }
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        this.socket.setTimeout(this.socketTimeoutMS || 0)
        resolve(this)
      }
      const connectTimer = setTimeout(() => fail(new MongoNetworkError(`connection to ${this.address} timed out after ${this.connectTimeoutMS}ms`)), this.connectTimeoutMS)
      connectTimer.unref?.()

      if (this.useTls) {
        const opts = { host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host, ...this.tlsOptions }
        if (this.tlsOptions.tlsAllowInvalidHostnames) opts.checkServerIdentity = () => undefined
        if (this.tlsOptions.tlsAllowInvalidCertificates) opts.rejectUnauthorized = false
        if (this.tlsOptions.ca === undefined && this.tlsOptions.tlsCAFile) opts.ca = readFileSync(this.tlsOptions.tlsCAFile)
        if (this.tlsOptions.tlsCertificateKeyFile) {
          const pem = readFileSync(this.tlsOptions.tlsCertificateKeyFile)
          opts.cert = pem; opts.key = pem
        }
        this.socket = tls.connect(opts, done)
      } else {
        this.socket = net.connect({ host: this.host, port: this.port }, done)
      }

      this.socket.setNoDelay(true)
      this.socket.setKeepAlive(true, 30000)
      this.socket.on('data', d => this._onData(d))
      this.socket.on('error', err => { fail(err); this._teardown(new MongoNetworkError(`socket error on ${this.address}: ${err.message}`, { cause: err })) })
      this.socket.on('close', () => this._teardown(new MongoNetworkError(`connection to ${this.address} closed`)))
      this.socket.on('timeout', () => { const e = new MongoNetworkError(`socket timeout on ${this.address}`); this.socket.destroy(e) })
    })
  }

  close() {
    this._teardown(new MongoNetworkError('connection closed by client'))
    this.socket?.destroy()
  }

  _teardown(err) {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    this.emit('close', err)
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0)
      if (len < WIRE_HEADER_LEN + 5 || len > WIRE_MAX_MESSAGE_SIZE) {
        this._teardown(new MongoNetworkError(`invalid message length ${len} from ${this.address}`))
        this.socket.destroy()
        return
      }
      if (this.buffer.length < len) return
      const frame = this.buffer.subarray(0, len)
      this.buffer = this.buffer.subarray(len)
      try { this._onMessage(frame) } catch (err) {
        this._teardown(new MongoNetworkError(`protocol error from ${this.address}: ${err.message}`, { cause: err }))
        this.socket.destroy()
        return
      }
    }
  }

  _onMessage(frame) {
    const responseTo = frame.readInt32LE(8)
    const opCode = frame.readInt32LE(12)
    if (opCode === WIRE_OP_COMPRESSED) throw new MongoError('WIRE_OP_COMPRESSED replies are not supported (do not negotiate compressors)')
    if (opCode !== WIRE_OP_MSG) throw new MongoError(`unexpected opcode ${opCode}`)
    const p = this.pending.get(responseTo)
    if (!p) return
    this.pending.delete(responseTo)
    clearTimeout(p.timer)
    try { p.resolve(decodeOpMsg(frame.subarray(WIRE_HEADER_LEN), this.bsonOptions)) } catch (e) { p.reject(e) }
  }

  async command(db, cmd, { documentSequences, timeoutMS } = {}) {
    if (this.closed) throw new MongoNetworkError(`connection to ${this.address} is closed`)
    const requestId = wireNextRequestId()
    const msg = encodeOpMsg({ ...cmd, $db: db }, requestId, { documentSequences })
    if (msg.length > WIRE_MAX_MESSAGE_SIZE) throw new MongoError(`command exceeds max message size (${msg.length} bytes)`)

    const reply = await new Promise((resolve, reject) => {
      const timer = timeoutMS ? setTimeout(() => {
        this.pending.delete(requestId)
        const err = new MongoNetworkError(`command timed out after ${timeoutMS}ms`)
        reject(err); this.close()
      }, timeoutMS) : null
      timer?.unref?.()
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket.write(msg, err => {
        if (err) { this.pending.delete(requestId); clearTimeout(timer); reject(new MongoNetworkError(`write failed: ${err.message}`, { cause: err })) }
      })
    })

    const { doc } = reply
    if (doc.ok !== 1 && doc.ok !== true) throw new MongoServerError(doc)
    return doc
  }

  async handshake({ username, password, authSource, authMechanism, appName, dbName } = {}) {
    const cmd = {
      hello: 1,
      helloOk: true,
      client: {
        application: appName ? { name: appName.slice(0, 128) } : undefined,
        driver: { name: 'native-nodejs', version: '1.0.0' },
        os: { type: os.type(), name: process.platform, architecture: process.arch, version: os.release() },
        platform: `Node.js ${process.version}`,
      },
    }
    const authDb = authSource || (username ? 'admin' : undefined)
    const mech = authMechanism && authMechanism !== 'DEFAULT' ? authMechanism : null
    if (username && !mech) cmd.saslSupportedMechs = `${authDb}.${username}`

    const hello = await this.command('admin', cmd, { timeoutMS: this.connectTimeoutMS })
    this.hello = hello
    if (hello.maxWireVersion < 8) throw new MongoError(`Server wire version ${hello.maxWireVersion} is too old; need MongoDB 4.2+ (wire version 8+)`)

    if (username) {
      let chosen = mech
      if (!chosen) {
        const supported = hello.saslSupportedMechs || []
        chosen = supported.includes('SCRAM-SHA-256') ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1'
      }
      if (!['SCRAM-SHA-256', 'SCRAM-SHA-1'].includes(chosen)) throw new MongoError(`Unsupported authMechanism "${chosen}" (supported: SCRAM-SHA-256, SCRAM-SHA-1)`)
      await this.authenticateScram(chosen, authDb, username, password ?? '')
    }
    return hello
  }

  async authenticateScram(mechanism, authDb, username, password) {
    const scram = new ScramClient({ mechanism, username, password })
    let r = await this.command(authDb, { saslStart: 1, mechanism, payload: scram.clientFirst(), autoAuthorize: 1, options: { skipEmptyExchange: true } })
    const conversationId = r.conversationId
    const payloadOf = res => {
      const p = res.payload
      if (Buffer.isBuffer(p)) return p
      if (p && Buffer.isBuffer(p.buffer)) return p.buffer
      throw new MongoError('SCRAM: server reply is missing a binary payload')
    }

    r = await this.command(authDb, { saslContinue: 1, conversationId, payload: scram.clientFinal(payloadOf(r)) })
    scram.verifyServerFinal(payloadOf(r))

    while (!r.done) {
      r = await this.command(authDb, { saslContinue: 1, conversationId, payload: Buffer.alloc(0) })
    }
  }
}

const MAX_BATCH_DOCS = 100_000
const MAX_BATCH_BYTES = 16 * 1024 * 1024

class FindCursor {
  constructor(collection, filter, options = {}) {
    this._col = collection
    this._filter = filter || {}
    this._opts = { ...options }
    this._buffer = null
    this._id = null
    this._closed = false
  }
  sort(spec) { this._opts.sort = spec; return this }
  limit(n) { this._opts.limit = n; return this }
  skip(n) { this._opts.skip = n; return this }
  project(p) { this._opts.projection = p; return this }
  batchSize(n) { this._opts.batchSize = n; return this }

  async _init() {
    if (this._buffer) return
    const cmd = { find: this._col.name, filter: this._filter }
    for (const k of ['sort', 'skip', 'limit', 'projection', 'batchSize', 'hint', 'maxTimeMS']) if (this._opts[k] !== undefined) cmd[k] = this._opts[k]
    if (cmd.limit === 0) delete cmd.limit
    const res = await this._col._run(cmd, { read: true })
    this._buffer = res.cursor.firstBatch
    this._id = BigInt(res.cursor.id?.toString?.() ?? res.cursor.id ?? 0)
    this._conn = res.__conn
  }

  async next() {
    await this._init()
    while (!this._buffer.length && this._id !== 0n && !this._closed) {
      const res = await this._col._run({ getMore: this._id, collection: this._col.name, ...(this._opts.batchSize ? { batchSize: this._opts.batchSize } : {}) }, { conn: this._conn })
      this._buffer = res.cursor.nextBatch
      this._id = BigInt(res.cursor.id?.toString?.() ?? res.cursor.id ?? 0)
    }
    return this._buffer.length ? this._buffer.shift() : null
  }

  async toArray() {
    const out = []
    for (let d = await this.next(); d !== null; d = await this.next()) out.push(d)
    return out
  }

  async forEach(fn) { for (let d = await this.next(); d !== null; d = await this.next()) await fn(d) }

  async close() {
    if (this._closed) return
    this._closed = true
    if (this._id && this._id !== 0n) {
      try { await this._col._run({ killCursors: this._col.name, cursors: [this._id] }, { conn: this._conn }) } catch {}
    }
    this._id = 0n
  }

  async *[Symbol.asyncIterator]() {
    try { for (let d = await this.next(); d !== null; d = await this.next()) yield d } finally { await this.close() }
  }
}

const mongoIsOperatorDoc = doc => Object.keys(doc).length > 0 && Object.keys(doc).every(k => k.startsWith('$'))

class Collection {
  constructor(db, name) { this.db = db; this.name = name }

  _run(cmd, opts) { return this.db._run(cmd, opts) }

  async _writeCmd(cmd, seqName, docs, { ordered = true } = {}) {
    const chunks = []
    let cur = [], bytes = 0
    for (const d of docs) {
      const approx = JSON.stringify(d)?.length ?? 64
      if (cur.length && (cur.length >= MAX_BATCH_DOCS || bytes + approx > MAX_BATCH_BYTES)) { chunks.push(cur); cur = []; bytes = 0 }
      cur.push(d); bytes += approx
    }
    if (cur.length) chunks.push(cur)

    const merged = { n: 0, nModified: 0, upserted: [], writeErrors: [] }
    let offset = 0
    for (const chunk of chunks) {
      const res = await this._run({ ...cmd, ordered }, { sequences: [{ identifier: seqName, documents: chunk }], write: true })
      merged.n += res.n || 0
      merged.nModified += res.nModified || 0
      for (const u of res.upserted || []) merged.upserted.push({ ...u, index: u.index + offset })
      for (const e of res.writeErrors || []) merged.writeErrors.push({ ...e, index: e.index + offset })
      if (res.writeConcernError) merged.writeConcernError = res.writeConcernError
      offset += chunk.length
      if (ordered && merged.writeErrors.length) break
    }
    if (merged.writeErrors.length) {
      const first = merged.writeErrors[0]
      throw new MongoServerError({ errmsg: first.errmsg, code: first.code, ok: 0, writeErrors: merged.writeErrors, result: merged })
    }
    if (merged.writeConcernError) throw new MongoServerError({ ...merged.writeConcernError, ok: 0 })
    return merged
  }

  find(filter = {}, options = {}) { return new FindCursor(this, filter, options) }

  async findOne(filter = {}, options = {}) {
    const cur = this.find(filter, { ...options, limit: 1, batchSize: 1 })
    try { return await cur.next() } finally { await cur.close() }
  }

  async insertOne(doc) {
    const d = { ...doc }
    if (d._id === undefined) d._id = new ObjectId()
    await this._writeCmd({ insert: this.name }, 'documents', [d])
    return { acknowledged: true, insertedId: d._id }
  }

  async insertMany(docs, { ordered = true } = {}) {
    const prepared = docs.map(x => (x._id === undefined ? { ...x, _id: new ObjectId() } : x))
    await this._writeCmd({ insert: this.name }, 'documents', prepared, { ordered })
    return { acknowledged: true, insertedCount: prepared.length, insertedIds: Object.fromEntries(prepared.map((d, i) => [i, d._id])) }
  }

  async _update(filter, update, { upsert = false, multi = false } = {}) {
    if (update && typeof update === 'object' && !Array.isArray(update) && !mongoIsOperatorDoc(update) && multi)
      throw new TypeError('Update document requires atomic operators ($set, $inc, ...)')
    const r = await this._writeCmd({ update: this.name }, 'updates', [{ q: filter, u: update, multi, upsert }])
    return { acknowledged: true, matchedCount: r.n - r.upserted.length, modifiedCount: r.nModified, upsertedCount: r.upserted.length, upsertedId: r.upserted[0]?._id ?? null }
  }
  async updateOne(filter, update, opts = {}) { return this._update(filter, update, { ...opts, multi: false }) }
  async updateMany(filter, update, opts = {}) { return this._update(filter, update, { ...opts, multi: true }) }
  async replaceOne(filter, doc, opts = {}) {
    if (mongoIsOperatorDoc(doc)) throw new TypeError('Replacement document must not contain atomic operators')
    return this._update(filter, doc, { ...opts, multi: false })
  }

  async deleteOne(filter = {}) {
    const r = await this._writeCmd({ delete: this.name }, 'deletes', [{ q: filter, limit: 1 }])
    return { acknowledged: true, deletedCount: r.n }
  }
  async deleteMany(filter = {}) {
    const r = await this._writeCmd({ delete: this.name }, 'deletes', [{ q: filter, limit: 0 }])
    return { acknowledged: true, deletedCount: r.n }
  }

  async countDocuments(filter = {}) {
    const r = await this._run({ count: this.name, query: filter }, { read: true })
    return r.n
  }

  async bulkWrite(operations, { ordered = true } = {}) {
    if (!operations.length) return { acknowledged: true, insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, upsertedIds: {} }
    const result = { acknowledged: true, insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, upsertedIds: {} }

    const groups = []
    operations.forEach((op, index) => {
      const kind = Object.keys(op)[0]
      const last = groups[groups.length - 1]
      if (last && last.kind === kind) last.items.push({ op: op[kind], index })
      else groups.push({ kind, items: [{ op: op[kind], index }] })
    })

    for (const g of groups) {
      if (g.kind === 'replaceOne' || g.kind === 'updateOne' || g.kind === 'updateMany') {
        const updates = g.items.map(({ op }) => {
          const u = g.kind === 'replaceOne' ? op.replacement : op.update
          if (g.kind === 'replaceOne' && mongoIsOperatorDoc(u)) throw new TypeError('Replacement document must not contain atomic operators')
          return { q: op.filter, u, multi: g.kind === 'updateMany', upsert: !!op.upsert }
        })
        const r = await this._writeCmd({ update: this.name }, 'updates', updates, { ordered })
        result.matchedCount += r.n - r.upserted.length
        result.modifiedCount += r.nModified
        result.upsertedCount += r.upserted.length
        for (const up of r.upserted) result.upsertedIds[g.items[up.index].index] = up._id
      } else if (g.kind === 'deleteOne' || g.kind === 'deleteMany') {
        const deletes = g.items.map(({ op }) => ({ q: op.filter, limit: g.kind === 'deleteOne' ? 1 : 0 }))
        const r = await this._writeCmd({ delete: this.name }, 'deletes', deletes, { ordered })
        result.deletedCount += r.n
      } else if (g.kind === 'insertOne') {
        const docs = g.items.map(({ op }) => (op.document._id === undefined ? { ...op.document, _id: new ObjectId() } : op.document))
        await this._writeCmd({ insert: this.name }, 'documents', docs, { ordered })
        result.insertedCount += docs.length
      } else {
        throw new TypeError(`Unsupported bulkWrite operation: ${g.kind}`)
      }
    }
    return result
  }

  async drop() { try { await this._run({ drop: this.name }, { write: true }) } catch (e) { if (e.code !== 26) throw e } return true }
}

class Db {
  constructor(client, name) { this.client = client; this.databaseName = name }
  collection(name) { return new Collection(this, name) }
  async listCollections() {
    const r = await this._run({ listCollections: 1 }, { read: true })
    return { toArray: async () => r.cursor.firstBatch }
  }
  command(cmd) { return this._run(cmd, {}) }
  _run(cmd, opts = {}) { return this.client._execute(this.databaseName, cmd, opts) }
}

const MONGO_RETRYABLE_CODES = new Set([6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436])

class MongoClient {
  constructor(uri, options = {}) {
    this.uri = uri
    this.options = options
    this._parsed = parseUri(uri)
    this._resolved = null
    this._pool = []
    this._all = new Set()
    this._opening = 0
    this._waiters = []
    this._connected = false
    this._closing = false
    this._maxPool = 5
  }

  async connect() {
    if (this._connected) return this
    const parsed = await resolveSrvUri(this._parsed)
    this._resolved = parsed
    const o = { ...parsed.options, ...this.options }
    this._opts = o
    this._maxPool = Math.max(1, o.maxPoolSize ?? 5)
    this._dbName = parsed.dbName

    const conn = await this._openConnection()
    this._pool.push(conn)
    this._connected = true
    this._closing = false
    return this
  }

  db(name) {
    if (!this._resolved) throw new MongoError('MongoClient must be connected before calling db()')
    return new Db(this, name || this._dbName)
  }

  async _openConnection() {
    const p = this._resolved
    const o = this._opts
    const deadline = Date.now() + (o.serverSelectionTimeoutMS ?? 30000)
    const useTls = !!o.tls
    const tlsOptions = {
      tlsAllowInvalidCertificates: o.tlsAllowInvalidCertificates,
      tlsAllowInvalidHostnames: o.tlsAllowInvalidHostnames,
      tlsCAFile: o.tlsCAFile,
      tlsCertificateKeyFile: o.tlsCertificateKeyFile,
    }
    const shuffled = [...p.hosts].sort(() => Math.random() - 0.5)
    let lastErr = null

    while (Date.now() < deadline) {
      for (const h of shuffled) {
        const conn = new Connection({ host: h.host, port: h.port, tls: useTls, tlsOptions, connectTimeoutMS: o.connectTimeoutMS ?? 10000, socketTimeoutMS: o.socketTimeoutMS ?? 0, appName: o.appName })
        try {
          await conn.connect()
          const hello = await conn.handshake({
            username: p.username, password: p.password,
            authSource: o.authSource || (p.hasDbName && p.username ? p.dbName : undefined) || 'admin',
            authMechanism: o.authMechanism, appName: o.appName,
          })
          const usable = o.directConnection || hello.isWritablePrimary || hello.ismaster || hello.msg === 'isdbgrid'
          if (!usable) {
            conn.close()
            const primary = hello.primary
            if (primary && !shuffled.some(x => `${x.host}:${x.port}` === primary.toLowerCase())) {
              const [ph, pp] = primary.split(':'); shuffled.push({ host: ph.toLowerCase(), port: Number(pp) || 27017 })
            }
            lastErr = new MongoNetworkError(`${h.host}:${h.port} is not a writable primary`)
            continue
          }
          conn.on('close', () => { this._all.delete(conn); this._pool = this._pool.filter(c => c !== conn) })
          this._all.add(conn)
          return conn
        } catch (err) {
          conn.close()
          if (err instanceof MongoServerError) throw err
          if (err.message?.startsWith('SCRAM:')) throw err
          lastErr = err
        }
      }
      await sleep(250)
    }
    throw new MongoNetworkError(`Server selection timed out after ${o.serverSelectionTimeoutMS ?? 30000}ms: ${lastErr?.message ?? 'no servers available'}`, { cause: lastErr })
  }

  async _acquire() {
    if (this._closing) throw new MongoError('MongoClient is closed')
    while (this._pool.length) {
      const c = this._pool.pop()
      if (!c.closed) return c
    }
    if (this._all.size + this._opening < this._maxPool) return this._openReserved()
    return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }))
  }

  async _openReserved() {
    this._opening++
    try { return await this._openConnection() } finally { this._opening-- }
  }

  _release(conn) {
    if (conn.closed) {
      const w = this._waiters.shift()
      if (w) this._openReserved().then(w.resolve, w.reject)
      return
    }
    const w = this._waiters.shift()
    if (w) w.resolve(conn)
    else this._pool.push(conn)
  }

  async _execute(dbName, cmd, { conn: pinned, sequences, read = false, write = false } = {}) {
    if (!this._connected) throw new MongoError('MongoClient is not connected')
    const retryable = (read && this._opts.retryReads !== false) || (write && this._opts.retryWrites !== false)
    const attempts = pinned ? 1 : retryable ? 2 : 1
    let lastErr

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const conn = pinned || await this._acquire()
      try {
        const res = await conn.command(dbName, cmd, { documentSequences: sequences, timeoutMS: this._opts.socketTimeoutMS || 60000 })
        Object.defineProperty(res, '__conn', { value: conn, enumerable: false })
        if (!pinned) this._release(conn)
        return res
      } catch (err) {
        if (!pinned) this._release(conn)
        lastErr = err
        const transient = err instanceof MongoNetworkError || (err instanceof MongoServerError && MONGO_RETRYABLE_CODES.has(err.code))
        const safe = read || (write && !mongoCmdHasNonIdempotentOps(cmd, sequences))
        if (!transient || attempt === attempts || !safe) throw err
        await sleep(100 * attempt)
      }
    }
    throw lastErr
  }

  async close() {
    this._closing = true
    this._connected = false
    for (const w of this._waiters.splice(0)) w.reject(new MongoError('MongoClient closed while waiting for a connection'))
    for (const c of this._all) c.close()
    this._all.clear(); this._pool = []
  }
}

function mongoCmdHasNonIdempotentOps(cmd, sequences) {
  if (!cmd.update) return false
  const updates = (sequences || []).flatMap(s => (s.identifier === 'updates' ? s.documents : []))
  return updates.some(u => u.u && typeof u.u === 'object' && (u.u.$inc || u.u.$push || u.u.$pull || u.u.$addToSet || u.u.$mul || u.u.$pop || u.u.$rename))
}

class MySqlAdapter {
  constructor(jdbcUrl) {
    const match = jdbcUrl.match(/jdbc:mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/)
    if (!match) throw new Error('Invalid JDBC format! Should be: jdbc:mysql://user:pass@host:port/database')

    const [, user, password, host, port, database] = match

    this.config = {
      host, user, password, database,
      port: parseInt(port),
      waitForConnections: true,
      connectionLimit: 10
    }
    this.pool = null
    this._inited = false
  }

  async getPool() {
    if (this.pool) return this.pool
    const mysql = await loadMysql()
    this.pool = mysql.createPool(this.config)
    return this.pool
  }

  async init() {
    if (this._inited) return
    const pool = await this.getPool()
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_data (
        id INT PRIMARY KEY DEFAULT 1,
        data LONGTEXT
      )
    `)
    this._inited = true
  }

  async read() {
    await this.init()
    const pool = await this.getPool()
    const [rows] = await pool.query('SELECT data FROM bot_data WHERE id = 1')
    return rows.length > 0 ? JSON.parse(rows[0].data || '{}') : {}
  }

  async write(obj) {
    await this.init()
    const pool = await this.getPool()
    const data = JSON.stringify(obj)
    await pool.query(
      'INSERT INTO bot_data (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = ?',
      [data, data]
    )
  }

  async close() {
    if (this.pool) await this.pool.end()
  }
}

class Mutex {
  constructor() {
    this._locked = false
    this._queue = []
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true
      return
    }
    await new Promise(resolve => this._queue.push(resolve))
  }

  release() {
    const next = this._queue.shift()
    if (next) next()
    else this._locked = false
  }
}

class MongoDB {
  constructor(url, options = {}) {
    this.url = url
    this.options = options
    this.data = {}
    this.db = null
    this.client = null
    this._writeMutex = new Mutex()
  }

  async initDB() {
    if (this.db) return this.db
    this._initPromise ??= (async () => {
      const client = new MongoClient(this.url, this.options)
      try {
        await client.connect()
      } catch (err) {
        this._initPromise = null
        await client.close().catch(() => {})
        throw err
      }
      this.client = client
      this.db = client.db()
      return this.db
    })()
    return this._initPromise
  }

  async close() {
    const c = this.client
    this.client = null
    this.db = null
    this._initPromise = null
    if (c) await c.close()
  }

  async read() {
    await this.initDB()

    const listCol = this.db.collection('lists')
    this.lists = await listCol.findOne({})
    if (!this.lists?.data) {
      await listCol.insertOne({ data: [] })
      this.lists = await listCol.findOne({})
    }

    const garbage = []
    this.data = {}

    await Promise.all(this.lists.data.map(async ({ name }) => {
      try {
        const collection = this.db.collection(name)
        const docs = await collection.find({}).toArray()
        this.data[name] = Object.fromEntries(docs.map(v => v.data))
      } catch (e) {
        garbage.push(name)
        console.error(e)
      }
    }))

    if (garbage.length) {
      try {
        await listCol.updateOne(
          { _id: this.lists._id },
          { $set: { data: this.lists.data.filter(v => !garbage.includes(v.name)) } }
        )
      } catch (e) {
        console.error(e)
      }
    }

    return this.data
  }

  async write(data) {
    await this._writeMutex.acquire()
    try {
      return await this._writeUnlocked(data)
    } finally {
      this._writeMutex.release()
    }
  }

  async _writeUnlocked(data) {
    if (!this.lists || !data) throw new Error('Write called before read(), or no data provided')

    const keys = Object.keys(data)

    await Promise.all(keys.map(async (key) => {
      const entries = Object.entries(data[key])
      const collection = this.db.collection(key)

      if (entries.length > 0) {
        const ops = entries.map(([itemKey, itemValue]) => ({
          replaceOne: {
            filter: { _key: itemKey },
            replacement: { _key: itemKey, data: [itemKey, itemValue] },
            upsert: true
          }
        }))
        await collection.bulkWrite(ops)

        const validKeys = entries.map(([itemKey]) => itemKey)
        await collection.deleteMany({ _key: { $nin: validKeys } })
      } else {
        await collection.deleteMany({})
      }
    }))

    const listDoc = keys.map(name => ({ name }))

    const listCol = this.db.collection('lists')
    const doc = await listCol.findOne({ _id: this.lists._id })
    if (!doc) {
      await this.read()
      return this._writeUnlocked(data)
    }

    await listCol.updateOne(
      { _id: this.lists._id },
      { $set: { data: listDoc } }
    )
    this.data = data
    return true
  }
}

const stringify = obj => JSON.stringify(obj, null, 2)
const parse = str => JSON.parse(str, (_, v) => {
  if (v !== null && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
    return Buffer.from(v.data)
  }
  return v
})

class CloudDBAdapter {
  constructor(url, { serialize = stringify, deserialize = parse, fetchOptions = {} } = {}) {
    this.url = url
    this.serialize = serialize
    this.deserialize = deserialize
    this.fetchOptions = fetchOptions
  }

  async read() {
    try {
      const res = await fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'application/json;q=0.9,text/plain' },
        ...this.fetchOptions
      })
      if (!res.ok) throw res.statusText
      return this.deserialize(await res.text())
    } catch {
      return null
    }
  }

  async write(obj) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...this.fetchOptions,
      body: this.serialize(obj)
    })
    if (!res.ok) throw res.statusText
    return await res.text()
  }
}

class SQLiteAdapter {
  constructor(filename) {
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_data (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT
      )
    `)
  }

  async read() {
    const row = this.db.prepare('SELECT data FROM bot_data WHERE id = 1').get()
    return row ? parse(row.data) : null
  }

  async write(obj) {
    const data = stringify(obj)
    this.db.prepare(`
      INSERT INTO bot_data (id, data) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(data)
  }

  close() {
    this.db.close()
  }
}

class Low {
  constructor(adapter, defaultData = null) {
    this.adapter = adapter
    this.data = defaultData
  }

  async read() {
    this.data = await this.adapter.read()
    return this.data
  }

  async write() {
    if (this.data === null || this.data === undefined) {
      throw new Error('Cannot write, data is null or undefined. Call read() first or set data manually.')
    }
    await this.adapter.write(this.data)
  }
}

function localSQLiteAdapter() {
  if (!existsSync('./data')) mkdirSync('./data')
  const prefix = Helper.opts._[0] ? Helper.opts._[0] + '_' : ''
  return new SQLiteAdapter(`./data/${prefix}database.db`)
}

class FallbackAdapter {
  constructor(primary, label) {
    this.primary = primary
    this.label = label
    this.fallback = null
  }

  async _getFallback() {
    if (!this.fallback) {
      console.error(chalk.red('[ DB ]') + chalk.gray(` ${this.label} unavailable, falling back to local SQLite so data keeps persisting.`))
      this.fallback = localSQLiteAdapter()
    }
    return this.fallback
  }

  async read() {
    if (this.fallback) return this.fallback.read()
    try {
      return await this.primary.read()
    } catch (err) {
      console.error(chalk.red('[ DB ]') + chalk.gray(` ${this.label} read() failed: ${err?.message || err}`))
      return (await this._getFallback()).read()
    }
  }

  async write(obj) {
    if (this.fallback) return this.fallback.write(obj)
    try {
      return await this.primary.write(obj)
    } catch (err) {
      console.error(chalk.red('[ DB ]') + chalk.gray(` ${this.label} write() failed: ${err?.message || err}`))
      return (await this._getFallback()).write(obj)
    }
  }

  async close() {
    if (this.fallback?.close) return this.fallback.close()
    if (this.primary?.close) return this.primary.close()
  }
}

function createDatabaseAdapter(databaseUrl) {
  if (databaseUrl && /mongodb(\+srv)?:\/\//i.test(databaseUrl)) return new FallbackAdapter(new MongoDB(databaseUrl, {}), 'MongoDB')
  if (databaseUrl && /mysql:\/\//i.test(databaseUrl)) return new FallbackAdapter(new MySqlAdapter(databaseUrl), 'MySQL')
  if (databaseUrl && /https?:\/\//.test(databaseUrl)) return new FallbackAdapter(new CloudDBAdapter(databaseUrl), 'CloudDB')

  return localSQLiteAdapter()
}

const database = new Low(createDatabaseAdapter(process.env.DATABASE || ''))

try {
  Object.defineProperty(database, 'adapter', { enumerable: false })
  Object.defineProperty(database, 'db', { enumerable: false })
  Object.defineProperty(database, 'conn', { enumerable: false })
} catch {}

const DB_AUTOSAVE_DEBOUNCE_MS = 15_000
const DB_AUTOSAVE_MAX_WAIT_MS = 60_000
let _autosaveTimer = null
let _autosaveFirstPendingAt = null
let _autosaveInFlight = false

function scheduleAutosave() {
  if (!database.data) return
  const now = Date.now()
  if (_autosaveFirstPendingAt === null) _autosaveFirstPendingAt = now

  if (_autosaveTimer) clearTimeout(_autosaveTimer)

  const elapsed = now - _autosaveFirstPendingAt
  const delay = Math.min(DB_AUTOSAVE_DEBOUNCE_MS, Math.max(0, DB_AUTOSAVE_MAX_WAIT_MS - elapsed))

  _autosaveTimer = setTimeout(async () => {
    _autosaveTimer = null
    _autosaveFirstPendingAt = null
    if (_autosaveInFlight) return
    _autosaveInFlight = true
    try {
      await database.write()
    } catch (err) {
      console.error('[DB AUTOSAVE] write failed:', err)
    } finally {
      _autosaveInFlight = false
    }
  }, delay)

  _autosaveTimer?.unref?.()
}

function createChainWrapper(data) {
  return {
    data: data,
    get(key) {
      return this.data[key]
    },
    set(key, value) {
      this.data[key] = value
      return this
    },
    has(key) {
      return key in this.data
    },
    clone() {
      return createChainWrapper(JSON.parse(JSON.stringify(this.data)))
    },
    value() {
      return this.data
    },
    map(fn) {
      if (Array.isArray(this.data)) {
        this.data = this.data.map(fn)
      }
      return this
    },
    filter(fn) {
      if (Array.isArray(this.data)) {
        this.data = this.data.filter(fn)
      }
      return this
    },
    reduce(fn, initial) {
      if (Array.isArray(this.data)) {
        this.data = this.data.reduce(fn, initial)
      }
      return this
    },
    keys() {
      if (typeof this.data === 'object' && this.data !== null) {
        return Object.keys(this.data)
      }
      return []
    },
    values() {
      if (typeof this.data === 'object' && this.data !== null) {
        return Object.values(this.data)
      }
      return []
    },
    entries() {
      if (typeof this.data === 'object' && this.data !== null) {
        return Object.entries(this.data)
      }
      return []
    },
    assign(obj) {
      if (typeof this.data === 'object' && this.data !== null) {
        this.data = { ...this.data, ...obj }
      }
      return this
    },
    omit(keys) {
      if (typeof this.data === 'object' && this.data !== null) {
        const newData = { ...this.data }
        keys.forEach(key => delete newData[key])
        this.data = newData
      }
      return this
    },
    pick(keys) {
      if (typeof this.data === 'object' && this.data !== null) {
        const newData = {}
        keys.forEach(key => {
          if (key in this.data) {
            newData[key] = this.data[key]
          }
        })
        this.data = newData
      }
      return this
    }
  }
}

async function loadDatabase() {
  if (database.data !== null) return database.data

  if (!database._loading) {
    database._loading = (async () => {
      try {
        database._read = database.read()
        await database._read
      } catch (err) {
        console.error(err)
      }

      database.data = {
        users: {},
        chats: {},
        stats: {},
        msgs: {},
        settings: {},
        agents: {},
        ...(database.data || {})
      }
      database.chain = createChainWrapper(database.data)

      return database.data
    })()
  }

  return database._loading
}

loadDatabase()

const DEFAULT = {
  user: {
    exp: 0,
    limit: 10,
    registered: false,
    afk: -1,
    afkReason: '',
    banned: false,
    warn: 0,
    level: 0,
    password: '',
    premium: false,
    premiumTime: 0,
    autoreconnect: false,
  },
  userUnregistered: {
    name: '',
    email: '',
    age: -1,
    regTime: -1,
  },
  chat: {
    isBanned: false,
    welcome: false,
    detect: false,
    sWelcome: '',
    sBye: '',
    sPromote: '',
    sDemote: '',
    delete: false,
    useDocument: false,
    viewonce: false,
    aiChat: false,
    aiSessionChat: [],
    expired: 0,
    antiLink: false,
    antispam: false,
    antinsfw: false,
  },
  settings: {
    self: false,
    restrict: false,
    status: 0,
    anticall: true,
    autoread: true,
    autorestart: false,
    clearlag: true,
    timeclearlag: 0,
    restartDB: 0,
    resetlimit: 0,
  },
}

function isNumber(x) {
  return typeof x === 'number' && !isNaN(x)
}

function splitDefaults(spec) {
  const numericKeys = Object.keys(spec).filter(key => typeof spec[key] === 'number')
  return { values: spec, numericKeys }
}

const { values: DEFAULT_USER, numericKeys: DEFAULT_USER_NUMERIC_KEYS } = splitDefaults(DEFAULT.user)
const { values: DEFAULT_USER_UNREGISTERED, numericKeys: DEFAULT_USER_UNREGISTERED_NUMERIC_KEYS } = splitDefaults(DEFAULT.userUnregistered)
const { values: DEFAULT_CHAT, numericKeys: DEFAULT_CHAT_NUMERIC_KEYS } = splitDefaults(DEFAULT.chat)
const { values: DEFAULT_SETTINGS, numericKeys: DEFAULT_SETTINGS_NUMERIC_KEYS } = splitDefaults(DEFAULT.settings)

function ensureDefaults(obj, defaults, numericKeys = []) {
  for (const key in defaults) {
    const isMissing = numericKeys.includes(key) ? !isNumber(obj[key]) : !(key in obj)
    if (isMissing) obj[key] = defaults[key]
  }
  return obj
}

function ensureUserDefaults(jid, extra = {}) {
  if (!database.data) throw new Error('ensureUserDefaults called before loadDatabase() resolved')
  if (typeof database.data.users[jid] !== 'object' || database.data.users[jid] === null) {
    database.data.users[jid] = {}
  }
  const user = database.data.users[jid]
  ensureDefaults(user, DEFAULT_USER, DEFAULT_USER_NUMERIC_KEYS)
  if (!user.registered) {
    ensureDefaults(user, DEFAULT_USER_UNREGISTERED, DEFAULT_USER_UNREGISTERED_NUMERIC_KEYS)
  }
  if (extra && typeof extra === 'object') {
    for (const key in extra) {
      if (extra[key] !== undefined && (user[key] === undefined || user[key] === null)) {
        user[key] = extra[key]
      }
    }
  }
  return user
}

function ensureChatDefaults(jid) {
  if (!database.data) throw new Error('ensureChatDefaults called before loadDatabase() resolved')
  if (typeof database.data.chats[jid] !== 'object' || database.data.chats[jid] === null) {
    database.data.chats[jid] = {}
  }
  ensureDefaults(database.data.chats[jid], DEFAULT_CHAT, DEFAULT_CHAT_NUMERIC_KEYS)
  return database.data.chats[jid]
}

function ensureSettingsDefaults(jid) {
  if (!database.data) throw new Error('ensureSettingsDefaults called before loadDatabase() resolved')
  if (typeof database.data.settings[jid] !== 'object' || database.data.settings[jid] === null) {
    database.data.settings[jid] = {}
  }
  ensureDefaults(database.data.settings[jid], DEFAULT_SETTINGS, DEFAULT_SETTINGS_NUMERIC_KEYS)
  return database.data.settings[jid]
}

function getUserAutoReconnect(jid, fallback = true) {
  const user = database.data?.users?.[jid]
  const value = user?.autoreconnect
  return value === undefined ? fallback : value
}

async function setUserAutoReconnect(jid, value) {
  ensureUserDefaults(jid)
  database.data.users[jid].autoreconnect = value
  try {
    await database.write()
  } catch (err) {
    console.error('[DB WRITE] setUserAutoReconnect failed to persist:', err)
  }
}

/**
 * Simpan/ambil koneksi WhatsApp Agent Platform (REST resmi, Bearer token) milik
 * seorang user, terpisah dari sesi subbot (baileys). Token disimpan sesudah
 * ensureUserDefaults dipanggil pada jid terkait.
 */
function getAgentSession(jid) {
  if (!database.data) return null
  return database.data.agents?.[jid] || null
}

async function setAgentSession(jid, session) {
  if (!database.data) return
  if (!database.data.agents) database.data.agents = {}
  if (session === null) {
    delete database.data.agents[jid]
  } else {
    database.data.agents[jid] = { ...database.data.agents[jid], ...session }
  }
  scheduleAutosave()
}

async function deleteAgentSession(jid) {
  return setAgentSession(jid, null)
}

export {
  database,
  loadDatabase,
  MongoDB,
  MySqlAdapter,
  CloudDBAdapter,
  SQLiteAdapter,
  ensureUserDefaults,
  ensureChatDefaults,
  ensureSettingsDefaults,
  getUserAutoReconnect,
  setUserAutoReconnect,
  getAgentSession,
  setAgentSession,
  deleteAgentSession,
  scheduleAutosave,
}

export default database