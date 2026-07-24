import Helper from './helper.js'
import { Low, JSONFile } from 'lowdb'
import lodash from 'lodash'
import chalk from 'chalk'
import { existsSync, mkdirSync } from 'fs'
import fetch from 'node-fetch'

let mysql = null
let _installingMysql = null

async function loadMysql() {
  if (mysql) return mysql
  if (_installingMysql) return _installingMysql

  _installingMysql = (async () => {
    try {
      const mod = await import('mysql2/promise')
      mysql = mod.default
      return mysql
    } catch (e) {}

    try {
      console.log(chalk.red('[ DB ]') + chalk.gray(' mysql2 not installed, installing...'))
      const { execSync } = await import('child_process')
      execSync('npm i mysql2 --no-save --force', { stdio: 'ignore' })
    } catch (installErr) {
      _installingMysql = null
      throw new Error('Failed to auto-install mysql2: ' + (installErr?.message || installErr))
    }

    try {
      const mod = await import('mysql2/promise')
      mysql = mod.default
      console.log(chalk.green('[ DB ]') + chalk.gray(' mysql2 installed & loaded successfully'))
      return mysql
    } catch (e) {
      _installingMysql = null
      console.error('[loadMysql] Installed but still failed to load:', e)
      throw new Error('mysql2 is installed but failed to load: ' + (e?.message || e))
    }
  })()

  return _installingMysql
}

class MySqlAdapter {
    constructor(jdbcUrl) {
        const match = jdbcUrl.match(/jdbc:mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
        if (!match) throw new Error("Invalid JDBC format! Should be: jdbc:mysql://user:pass@host:port/database");

        const [_, user, password, host, port, database] = match;

        this.config = {
            host,
            user,
            password,
            port: parseInt(port),
            database,
            waitForConnections: true,
            connectionLimit: 10
        };
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
        `);
        this._inited = true
    }

    async read() {
        await this.init();
        const pool = await this.getPool()
        const [rows] = await pool.query('SELECT data FROM bot_data WHERE id = 1');
        return rows.length > 0? JSON.parse(rows[0].data || '{}') : {};
    }

    async write(obj) {
        await this.init();
        const pool = await this.getPool()
        const data = JSON.stringify(obj);
        await pool.query(`
            INSERT INTO bot_data (id, data) VALUES (1,?)
            ON DUPLICATE KEY UPDATE data =?
        `, [data, data]);
    }

    async close() {
        if (this.pool) await this.pool.end()
    }
}

let mongoose = null
let Schema, connect, _model
let _installingMongoose = null

function applyMongoose(mod) {
  mongoose = mod.default
  Schema = mongoose.Schema
  connect = mongoose.connect
  _model = mongoose.model
  return { Schema, connect, _model }
}

async function loadMongoose() {
  if (mongoose) return { Schema, connect, _model }
  if (_installingMongoose) return _installingMongoose

  _installingMongoose = (async () => {
    try {
      const mod = await import('mongoose')
      return applyMongoose(mod)
    } catch (e) {}

    try {
      console.log(chalk.red('[ DB ]') + chalk.gray(' mongoose not installed, installing...'))
      const { execSync } = await import('child_process')
      execSync('npm i mongoose --no-save --force', { stdio: 'ignore' })
    } catch (installErr) {
      _installingMongoose = null
      throw new Error('Failed to auto-install mongoose: ' + (installErr?.message || installErr))
    }

    try {
      const mod = await import('mongoose')
      console.log(chalk.green('[ DB ]') + chalk.gray(' mongoose installed & loaded successfully'))
      return applyMongoose(mod)
    } catch (e) {
      _installingMongoose = null
      console.error('[loadMongoose] Installed but still failed to load:', e)
      throw new Error('Mongoose is installed but failed to load: ' + (e?.message || e))
    }
  })()

  return _installingMongoose
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
    let schema = this._schema = new Schema({
      data: {
        type: Object,
        required: true,
        default: {}
      }
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
    } else this.data = this._data.data
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
    await new Promise((resolve) => this._queue.push(resolve))
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
    this.lists
    this.list
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
    let schema = new Schema({
      data: [{
        name: String,
      }]
    })
    try {
      this.list = _model('lists', schema)
    } catch (e) {
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
        } catch (e) {
          garbage.push(name)
          console.error(e)
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
      let del = await this.list.findById(this.lists._id)
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
    const collections = Object.keys(data)
    const listDoc = []

    for (const key of collections) {
      const entries = Object.entries(data[key])
      let index = this.models.findIndex(v => v.name === key)

      if (index === -1) {
        const schema = new Schema({ data: Array }, { strict: false })
        let doc
        try {
          doc = _model(key, schema)
        } catch (e) {
          doc = _model(key)
        }
        this.models.push({ name: key, model: doc })
        index = this.models.length - 1
      }

      const model = this.models[index].model

      if (entries.length > 0) {
        const bulkOps = entries.map(([itemKey, itemValue]) => ({
          replaceOne: {
            filter: { _key: itemKey },
            replacement: { _key: itemKey, data: [itemKey, itemValue] },
            upsert: true
          }
        }))
        await model.bulkWrite(bulkOps)

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
    if (
        v !== null &&
        typeof v === 'object' &&
        'type' in v &&
        v.type === 'Buffer' &&
        'data' in v &&
        Array.isArray(v.data)) {
        return Buffer.from(v.data)
    }
    return v
})

class CloudDBAdapter {
    constructor(url, {
        serialize = stringify,
        deserialize = parse,
        fetchOptions = {}
    } = {}) {
        this.url = url
        this.serialize = serialize
        this.deserialize = deserialize
        this.fetchOptions = fetchOptions
    }

    async read() {
        try {
            let res = await fetch(this.url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json;q=0.9,text/plain'
                },
                ...this.fetchOptions
            })
            if (!res.ok) throw res.statusText
            return this.deserialize(await res.text())
        } catch (e) {
            return null
        }
    }

    async write(obj) {
        let res = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            ...this.fetchOptions,
            body: this.serialize(obj)
        })
        if (!res.ok) throw res.statusText
        return await res.text()
    }
}

const databaseUrl = process.env.DATABASE || ''

let databaseAdapter

if (databaseUrl && /mongodb(\+srv)?:\/\//i.test(databaseUrl)) {
  console.log(chalk.cyan('Database') + chalk.gray(' Using MongoDB adapter'))
  databaseAdapter = new MongoDBV2(databaseUrl, {})
} else if (databaseUrl && /mysql:\/\//i.test(databaseUrl)) {
  console.log(chalk.cyan('Database') + chalk.gray(' Using MySQL adapter'))
  databaseAdapter = new MySqlAdapter(databaseUrl)
} else if (databaseUrl && /https?:\/\//.test(databaseUrl)) {
  console.log(chalk.cyan('Database') + chalk.gray(' Using Cloud DB adapter'))
  databaseAdapter = new CloudDBAdapter(databaseUrl)
} else {
  console.log(chalk.cyan('Database') + chalk.gray(' Using JSON file adapter'))
  if (!existsSync('./data')) mkdirSync('./data')
  databaseAdapter = new JSONFile(`./data/${Helper.opts._[0] ? Helper.opts._[0] + '_' : ''}database.json`)
}

let database = new Low(databaseAdapter)

try {
  Object.defineProperty(database, 'adapter', { enumerable: false })
  Object.defineProperty(database, 'db', { enumerable: false })
  Object.defineProperty(database, 'conn', { enumerable: false })
} catch (e) {
}

loadDatabase()

async function loadDatabase() {
  if (database._read) await database._read
  if (database.data !== null) return database.data
  database._read = database.read().catch(console.error)
  await database._read
  console.log(chalk.cyan('Database loaded'))
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
}


export {
  database,
  loadDatabase,
  mongoDB,
  MongoDBV2,
  MySqlAdapter,
  CloudDBAdapter
}

export default database
