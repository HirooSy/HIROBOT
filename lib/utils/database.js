import Helper from './helper.js'
import chalk from './color.js'
import { existsSync, mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'

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

const loadMongo = createLazyLoader('mongodb', mod => ({ MongoClient: mod.MongoClient || mod.default?.MongoClient }))

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
    const { MongoClient } = await loadMongo()
    this.client = new MongoClient(this.url, this.options)
    await this.client.connect()
    this.db = this.client.db()
    return this.db
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

    const listDoc = []

    for (const key of Object.keys(data)) {
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

      listDoc.push({ name: key })
    }

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
}

export default database