import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MongoDB, MySqlAdapter, SQLiteAdapter } from '../../lib/utils/database.js'
import Helper from '../../lib/utils/helper.js'

function getLocalDbPath() {
  const prefix = Helper.opts._[0] ? Helper.opts._[0] + '_' : ''
  return join(process.cwd(), 'data', `${prefix}database.db`)
}

function detectCloudType(url) {
  if (!url) return null
  if (/^mongodb(\+srv)?:\/\//i.test(url)) return 'mongodb'
  if (/^mysql:\/\//i.test(url)) return 'mysql'
  return null
}

function getCloudAdapter(url, type) {
  if (type === 'mongodb') return new MongoDB(url, {})
  if (type === 'mysql') return new MySqlAdapter(url)
  throw new Error('Unknown cloud database type')
}

function mergeData(target, source) {
  target = target && typeof target === 'object' ? target : {}
  source = source && typeof source === 'object' ? source : {}

  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

    if (isPlainObj(srcVal)) {
      if (!isPlainObj(target[key])) target[key] = {}
      target[key] = { ...target[key], ...srcVal }
    } else {
      target[key] = srcVal
    }
  }
  return target
}

function countEntries(data) {
  if (!data || typeof data !== 'object') return 0
  return Object.values(data).reduce((acc, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return acc + Object.keys(v).length
    return acc + 1
  }, 0)
}

async function closeAdapter(adapter) {
  try {
    if (adapter?.close) await adapter.close()
  } catch {}
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  const direction = (text || '').trim().toLowerCase()

  if (!['local-cloud', 'cloud-local'].includes(direction)) {
    throw `Invalid format!

*${usedPrefix + command} local-cloud*
> Migrate data from the local file (data/database.db) to the cloud database (Mongo/MySQL, depending on the DATABASE env)

*${usedPrefix + command} cloud-local*
> Migrate data from the cloud database (Mongo/MySQL) to the local file (data/database.db)

_This command auto-detects MongoDB or MySQL from the DATABASE env value._`
  }

  const dbUrl = process.env.DATABASE || ''
  const cloudType = detectCloudType(dbUrl)
  const localPath = getLocalDbPath()
  const localExists = existsSync(localPath)

  if (direction === 'local-cloud') {
    if (!localExists) {
      throw `❌ File *data/database.db* not found.

There is no local data to migrate.`
    }
    if (!cloudType) {
      throw `❌ The *DATABASE* env is not set to a valid MongoDB/MySQL token.

Set the *DATABASE* env to a Mongo (mongodb://...) or MySQL (mysql://...) connection string before migrating to the cloud.`
    }

    await m.reply(`Starting migration *local ➜ ${cloudType.toUpperCase()}*, please wait...`)

    const localAdapter = new SQLiteAdapter(localPath)
    let localData
    try {
      localData = await localAdapter.read()
    } finally {
      await closeAdapter(localAdapter)
    }

    if (!localData || countEntries(localData) === 0) {
      throw `❌ Data in *data/database.db* is empty, nothing to migrate.`
    }

    const cloudAdapter = getCloudAdapter(dbUrl, cloudType)
    let cloudData = {}
    try {
      cloudData = (await cloudAdapter.read()) || {}
    } catch (e) {
      cloudData = {}
    }

    const beforeCount = countEntries(cloudData)
    const merged = mergeData(cloudData, localData)
    await cloudAdapter.write(merged)
    await closeAdapter(cloudAdapter)

    return m.reply(`✅ Migration *local ➜ ${cloudType.toUpperCase()}* completed!

- Local data: ${countEntries(localData)} entries
- Cloud data before: ${beforeCount} entries
- Cloud data now: ${countEntries(merged)} entries

_Only copies data, nothing was deleted from either local or cloud._`)
  }

  if (direction === 'cloud-local') {
    if (!cloudType) {
      throw `❌ The *DATABASE* env is not set to a valid MongoDB/MySQL token.`
    }
    if (localExists) {
      throw `❌ File *data/database.db* already exists.

This command only runs when there is no local database yet, to avoid an unwanted migration. Remove/move *data/database.db* first if you really want to pull the data from the cloud again.`
    }

    await m.reply(`Starting migration *${cloudType.toUpperCase()} ➜ local*, please wait...`)

    const cloudAdapter = getCloudAdapter(dbUrl, cloudType)
    let cloudData
    try {
      cloudData = await cloudAdapter.read()
    } finally {
      await closeAdapter(cloudAdapter)
    }

    if (!cloudData || countEntries(cloudData) === 0) {
      throw `❌ Data in the cloud database (${cloudType.toUpperCase()}) is empty, nothing to migrate.`
    }

    if (!existsSync(join(process.cwd(), 'data'))) mkdirSync(join(process.cwd(), 'data'))

    const localAdapter = new SQLiteAdapter(localPath)
    let merged
    try {
      const existingLocal = (await localAdapter.read()) || {}
      merged = mergeData(existingLocal, cloudData)
      await localAdapter.write(merged)
    } finally {
      await closeAdapter(localAdapter)
    }

    return m.reply(`✅ Migration *${cloudType.toUpperCase()} ➜ local* completed!

- Cloud data: ${countEntries(cloudData)} entries
- Local data now: ${countEntries(merged)} entries
- Saved to: data/database.db

_Only copies data, nothing was deleted from either cloud or local._`)
  }
}

handler.command = /^migratedb$/i
handler.tags = ['owner']
handler.help = ['migratedb <local-cloud/cloud-local>']
handler.rowner = true
handler.private = true
handler.ai = { risk: 'low', description: 'migrate database contents between local sqlite and mongodb/mysq' }

export default handler