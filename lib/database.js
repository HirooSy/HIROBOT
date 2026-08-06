import Helper from './helper.js'
import lodash from 'lodash'
import chalk from 'chalk'
import { existsSync, mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'

function createLazyLoader(pkgName, onLoaded) {
  let loaded = null
  let loading = null

  return async function load() {
    if (loaded) return loaded
    if (loading) return loading

    loading = (async () => {
      try {
        return (loaded = onLoaded(await import(pkgName)))
      } catch {}

      try {
        console.log(chalk.red('[ DB ]') + chalk.gray(` ${pkgName} not installed, installing...`))
        const { execSync } = await import('child_process')
        execSync(`npm i ${pkgName} --no-save --force`, { stdio: 'ignore' })
      } catch (installErr) {
        loading = null
        throw new Error(`Failed to auto-install ${pkgName}: ${installErr?.message || installErr}`)
      }

      try {
        const result = (loaded = onLoaded(await import(pkgName)))
        console.log(chalk.green('[ DB ]') + chalk.gray(` ${pkgName} installed & loaded successfully`))
        return result
      } catch (e) {
        loading = null
        console.error(`[${pkgName}] Installed but still failed to load:`, e)
        throw new Error(`${pkgName} is installed but failed to load: ${e?.message || e}`)
      }
    })()

    return loading
  }
}

const loadMysql = createLazyLoader('mysql2/promise', mod => mod.default)

let mongooseExports = { Schema: null, connect: null, _model: null }
const loadMongoose = createLazyLoader('mongoose', mod => {
  mongooseExports = { Schema: mod.default.Schema, connect: mod.default.connect, _model: mod.default.model }
  return mongooseExports
})

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

class mongoDB {
  constructor(url, options = {}) {
    this.url = url
    this.options = options
    this.data = this._data = {}
    this._schema = {}
    this._model = {}
    this.db = null
  }

  async initDB() {
    if (this.db) return this.db
    const { connect } = await loadMongoose()
    this.db = connect(this.url, this.options).catch(console.error)
    return this.db
  }

  async read() {
    const { Schema, _model } = await loadMongoose()
    this.conn = await this.initDB()

    const schema = this._schema = new Schema({
      data: { type: Object, required: true, default: {} }
    })

    try {
      this._model = _model('data', schema)
    } catch {
      this._model = _model('data')
    }

    this._data = await this._model.findOne({})
    if (!this._data) {
      this.data = {}
      await this.write(this.data)
      this._data = await this._model.findOne({})
    } else {
      this.data = this._data.data
    }

    return this.data
  }

  async write(data) {
    if (!data) throw new Error('Data is required')
    const { _model } = await loadMongoose()

    if (!this._data) {
      this._data = await (new this._model({ data })).save()
      return this._data
    }

    this._data = await this._model.findOneAndUpdate(
      { _id: this._data._id },
      { $set: { data } },
      { new: true }
    )
    this.data = data
    return this._data
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

class MongoDBV2 {
  constructor(url, options = {}) {
    this.url = url
    this.options = options
    this.models = []
    this.data = {}
    this.lists = undefined
    this.list = undefined
    this.db = null
    this._writeMutex = new Mutex()
  }

  async initDB() {
    if (this.db) return this.db
    const { connect } = await loadMongoose()
    this.db = connect(this.url, this.options).catch(console.error)
    return this.db
  }

  async read() {
    const { Schema, _model } = await loadMongoose()
    this.conn = await this.initDB()

    const schema = new Schema({ data: [{ name: String }] })
    try {
      this.list = _model('lists', schema)
    } catch {
      this.list = _model('lists')
    }

    this.lists = await this.list.findOne({})
    if (!this.lists?.data) {
      await this.list.create({ data: [] })
      this.lists = await this.list.findOne({})
    }

    const garbage = []
    await Promise.all(this.lists.data.map(async ({ name }) => {
      let collection
      try {
        collection = _model(name, new Schema({ data: Array }, { strict: false }))
      } catch (e) {
        console.error(e)
        try {
          collection = _model(name)
        } catch (e2) {
          garbage.push(name)
          console.error(e2)
        }
      }

      if (collection) {
        const index = this.models.findIndex(v => v.name === name)
        if (index !== -1) this.models[index].model = collection
        else this.models.push({ name, model: collection })

        const collectionsData = await collection.find({})
        this.data[name] = Object.fromEntries(collectionsData.map(v => v.data))
      }
    }))

    try {
      const del = await this.list.findById(this.lists._id)
      del.data = del.data.filter(v => !garbage.includes(v.name))
      await del.save()
    } catch (e) {
      console.error(e)
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
    const { Schema, _model } = await loadMongoose()
    if (!this.lists || !data) throw new Error('Write called before read(), or no data provided')

    const listDoc = []

    for (const key of Object.keys(data)) {
      const entries = Object.entries(data[key])
      let index = this.models.findIndex(v => v.name === key)

      if (index === -1) {
        const schema = new Schema({ data: Array }, { strict: false })
        let doc
        try {
          doc = _model(key, schema)
        } catch {
          doc = _model(key)
        }
        this.models.push({ name: key, model: doc })
        index = this.models.length - 1
      }

      const model = this.models[index].model

      if (entries.length > 0) {
        await model.bulkWrite(entries.map(([itemKey, itemValue]) => ({
          replaceOne: {
            filter: { _key: itemKey },
            replacement: { _key: itemKey, data: [itemKey, itemValue] },
            upsert: true
          }
        })))

        const validKeys = entries.map(([itemKey]) => itemKey)
        await model.deleteMany({ _key: { $nin: validKeys } })
      } else {
        await model.deleteMany({})
      }

      listDoc.push({ name: key })
    }

    const doc = await this.list.findById(this.lists._id)
    if (!doc) {
      await this.read()
      return this._writeUnlocked(data)
    }

    doc.data = listDoc
    await doc.save()
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
  if (databaseUrl && /mongodb(\+srv)?:\/\//i.test(databaseUrl)) return new MongoDBV2(databaseUrl, {})
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
  mongoDB,
  MongoDBV2,
  MySqlAdapter,
  CloudDBAdapter,
  SQLiteAdapter
}

export default database
