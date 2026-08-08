import Helper from './helper.js'
import lodash from 'lodash'
import chalk from './color.js'
import { existsSync, mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'

function createLazyLoader(pkgName, onLoaded) {
  let loaded = null
  let loading = null

  async function resolveEntryPath(projectRoot) {
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
    candidates.push('index.js', 'lib/index.js', 'mongodb.js', 'mongodb.mjs')

    for (const rel of candidates) {
      if (!rel) continue
      const full = path.join(pkgDir, rel)
      if (fs.existsSync(full)) return full
    }
    return null
  }

  async function tryLoad() {
    try {
      return onLoaded(await import(pkgName))
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err

      const { fileURLToPath, pathToFileURL } = await import('url')
      const path = await import('path')
      const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
      const entryPath = await resolveEntryPath(projectRoot)

      if (!entryPath) throw err
      return onLoaded(await import(pathToFileURL(entryPath).href))
    }
  }

  async function install() {
    const { execSync } = await import('child_process')
    const { fileURLToPath } = await import('url')
    const path = await import('path')
    const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

    execSync(`npm i ${pkgName} --no-save`, {
      cwd: projectRoot,
      stdio: 'ignore'
    })
  }

  return async function load() {
    if (loaded) return loaded
    if (loading) return loading

    loading = (async () => {
      try {
        return (loaded = await tryLoad())
      } catch (firstErr) {
        console.log(chalk.yellow('[ DB ]') + chalk.gray(` ${pkgName} initial load failed (${firstErr?.code || firstErr?.message || firstErr}), attempting install...`))
      }

      console.log(chalk.red('[ DB ]') + chalk.gray(` ${pkgName} not installed, installing...`))

      try {
        await install()
      } catch (installErr) {
        loading = null
        throw new Error(`Failed to auto-install ${pkgName}: ${installErr?.message || installErr}`)
      }

      try {
        const result = (loaded = await tryLoad())
        console.log(chalk.green('[ DB ]') + chalk.gray(` ${pkgName} installed & loaded successfully`))
        return result
      } catch (e) {
        console.log(chalk.yellow('[ DB ]') + chalk.gray(` ${pkgName} install looked corrupted, retrying...`))
        try {
          const { rmSync } = await import('fs')
          const path = await import('path')
          const { fileURLToPath } = await import('url')
          const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
          rmSync(path.join(projectRoot, 'node_modules', pkgName), { recursive: true, force: true })
          await install()
          const result = (loaded = await tryLoad())
          console.log(chalk.green('[ DB ]') + chalk.gray(` ${pkgName} installed & loaded successfully (after retry)`))
          return result
        } catch (e2) {
          loading = null
          console.error(`[${pkgName}] Installed but still failed to load:`, e2)
          throw new Error(`${pkgName} is installed but failed to load: ${e2?.message || e2}`)
        }
      }
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

function createDatabaseAdapter(databaseUrl) {
  if (databaseUrl && /mongodb(\+srv)?:\/\//i.test(databaseUrl)) return new MongoDB(databaseUrl, {})
  if (databaseUrl && /mysql:\/\//i.test(databaseUrl)) return new MySqlAdapter(databaseUrl)
  if (databaseUrl && /https?:\/\//.test(databaseUrl)) return new CloudDBAdapter(databaseUrl)

  if (!existsSync('./data')) mkdirSync('./data')
  const prefix = Helper.opts._[0] ? Helper.opts._[0] + '_' : ''
  return new SQLiteAdapter(`./data/${prefix}database.db`)
}

const database = new Low(createDatabaseAdapter(process.env.DATABASE || ''))

try {
  Object.defineProperty(database, 'adapter', { enumerable: false })
  Object.defineProperty(database, 'db', { enumerable: false })
  Object.defineProperty(database, 'conn', { enumerable: false })
} catch {}

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
      database.chain = lodash.chain(database.data)

      return database.data
    })()
  }

  return database._loading
}

loadDatabase()

export {
  database,
  loadDatabase,
  MongoDB,
  MySqlAdapter,
  CloudDBAdapter,
  SQLiteAdapter
}

export default database
