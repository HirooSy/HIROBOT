import chalk from './color.js'
import fs from 'fs'
import path, { resolve } from 'path'
import readline from 'readline'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import db, { loadDatabase } from './database.js'
import Helper from './helper.js'
import { fileURLToPath } from 'url'
import { HelperConnection } from './simple.js'

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  PHONENUMBER_MCC,
  Browsers,
  BufferJSON,
  makeCacheableSignalKeyStore,
  proto,
  isJidBroadcast,
  isJidGroup,
  WAMessageStubType,
  updateMessageWithReceipt,
  updateMessageWithReaction,
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
  initAuthCreds,
  useMultiFileAuthState
} = await import('baileys')

class StoreLock {
  #chains = new Map()

  run(key, task) {
    const previous = this.#chains.get(key)
    const current = previous ? previous.then(task, task) : task()
    const tracker = Promise.resolve(current).then(() => {}, () => {})
    this.#chains.set(key, tracker)
    tracker.then(() => {
      if (this.#chains.get(key) === tracker) this.#chains.delete(key)
    })
    return current
  }

  runMany(keys, task) {
    const unique = [...new Set(keys)].sort()
    if (unique.length === 0) return task()
    if (unique.length === 1) return this.run(unique[0], task)
    const acquire = (i) =>
      i >= unique.length
        ? task()
        : this.run(unique[i], () => acquire(i + 1))
    return acquire(0)
  }
}

const signalKeyLock = new StoreLock()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TIME_TO_DATA_STALE = 5 * 60 * 1000
const MAX_MESSAGES_PER_CHAT = 100

function makeInMemoryStore() {
  let chats = {}
  let messages = {}
  let state = { connection: 'close' }

  function loadMessage(jid, id = null) {
    let message = null
    if (jid && !id) {
      id = jid
      const filter = (m) => m.key?.id == id
      const messageFind = Object.entries(messages).find(([, msgs]) => msgs.find(filter))
      message = messageFind?.[1]?.find(filter)
    } else {
      jid = jid?.decodeJid?.()
      if (!(jid in messages)) return null
      message = messages[jid].find(m => m.key.id == id)
    }
    return message ? message : null
  }

  async function fetchGroupMetadata(jid, groupMetadata) {
    jid = jid?.decodeJid?.()
    if (!isJidGroup(jid)) return
    if (!(jid in chats)) return chats[jid] = { id: jid }
    const isRequiredToUpdate = !chats[jid].metadata || Date.now() - (chats[jid].lastfetch || 0) > TIME_TO_DATA_STALE
    if (isRequiredToUpdate) {
      const metadata = await groupMetadata?.(jid)
      if (metadata) Object.assign(chats[jid], {
        subject: metadata.subject,
        lastfetch: Date.now(),
        metadata
      })
    }
    return chats[jid].metadata
  }

  function getContact(jid) {
    jid = jid?.decodeJid?.()
    if (!(jid in chats)) return null
    return chats[jid]
  }

  function getNumberFromLid(lidNumber) {
    if (!lidNumber || !lidNumber.endsWith('@lid')) return null
    const lidNum = lidNumber.split('@')[0]

    const direct = chats[lidNumber]
    if (direct?.number?.endsWith('@s.whatsapp.net')) {
      console.log(`[Store] LID reverse map hit: ${lidNumber} → ${direct.number}`)
      return direct.number
    }

    for (const [jid, contact] of Object.entries(chats)) {
      if (!jid.endsWith('@s.whatsapp.net')) continue
      if (contact.lid === lidNumber || contact.linkedIdentity === lidNumber) {
        console.log(`[Store] Found via contact.lid: ${lidNumber} → ${jid}`)
        return jid
      }
    }

    for (const [groupJid, chat] of Object.entries(chats)) {
      if (!groupJid.endsWith('@g.us')) continue
      const participants = chat.metadata?.participants
      if (!Array.isArray(participants)) continue
      for (const p of participants) {
        let pLid = null
        let pNumber = null
        const rawId = p.id
        if (rawId && typeof rawId === 'object') {
          const innerId = String(rawId.id || rawId.jid || '')
          if (innerId.endsWith('@lid')) pLid = innerId
          const innerPn = rawId.phoneNumber || rawId.pn || ''
          if (String(innerPn).endsWith('@s.whatsapp.net')) pNumber = String(innerPn)
        } else if (typeof rawId === 'string') {
          if (rawId.endsWith('@lid')) pLid = rawId
          else if (rawId.endsWith('@s.whatsapp.net')) pNumber = rawId
        }
        const topPn = p.phoneNumber || p.pn || p.phone_number
        if (topPn) {
          if (String(topPn).endsWith('@s.whatsapp.net')) pNumber = String(topPn)
          else {
            const c = String(topPn).replace(/[^0-9]/g, '')
            if (c.length >= 7) pNumber = c + '@s.whatsapp.net'
          }
        }
        if (p.lid && String(p.lid).endsWith('@lid')) pLid = String(p.lid)

        const isMatch = pLid === lidNumber || pLid?.split('@')[0] === lidNum
        if (!isMatch) continue
        if (pNumber) {
          console.log(`[Store] Found via group ${groupJid}: ${lidNumber} → ${pNumber}`)
          return pNumber
        }
      }
    }
    return null
  }

  function getLidFromNumber(number) {
    if (!number || !number.endsWith('@s.whatsapp.net')) return null
    const contact = chats[number]
    if (contact && (contact.lid || contact.linkedIdentity)) {
      return contact.lid || contact.linkedIdentity
    }
    return null
  }

  function cachePnFromParticipants(participants) {
    if (!Array.isArray(participants)) return
    for (const p of participants) {
      let pLid = null
      let pNumber = null

      const rawId = p.id
      if (rawId && typeof rawId === 'object') {
        const innerId = String(rawId.id || rawId.jid || '')
        if (innerId.endsWith('@lid')) pLid = innerId
        const innerPn = rawId.phoneNumber || rawId.pn || ''
        if (String(innerPn).endsWith('@s.whatsapp.net')) pNumber = String(innerPn)
      } else if (typeof rawId === 'string' && rawId.endsWith('@lid')) {
        pLid = rawId
      }

      const topPn = p.phoneNumber || p.pn || p.phone_number
      if (topPn) {
        if (String(topPn).endsWith('@s.whatsapp.net')) pNumber = String(topPn)
        else {
          const c = String(topPn).replace(/[^0-9]/g, '')
          if (c.length >= 7) pNumber = c + '@s.whatsapp.net'
        }
      }
      if (p.lid && String(p.lid).endsWith('@lid')) pLid = String(p.lid)

      if (pLid && pNumber) {
        if (!chats[pLid]) chats[pLid] = {}
        if (!chats[pLid].number) {
          chats[pLid].number = pNumber
          chats[pLid].lid = pLid
          console.log(`[Store] cachePn: ${pLid} → ${pNumber}`)
        }
        if (!chats[pNumber]) chats[pNumber] = {}
        if (!chats[pNumber].lid) {
          chats[pNumber].lid = pLid
        }
      }
    }
  }

  const upsertMessage = (jid, message, type = 'append') => {
    jid = jid?.decodeJid?.()
    if (!(jid in messages)) messages[jid] = []

    delete message.message?.messageContextInfo
    delete message.message?.senderKeyDistributionMessage

    if (!chats[jid]) chats[jid] = {}
    chats[jid].lastfetch = Date.now()

    const msg = loadMessage(jid, message.key.id)
    if (msg) {
      Object.assign(msg, message)
    } else if (type == 'append') {
      messages[jid].push(message)
      if (messages[jid].length > MAX_MESSAGES_PER_CHAT) {
        messages[jid] = messages[jid].slice(-MAX_MESSAGES_PER_CHAT)
      }
    } else {
      messages[jid].splice(0, 0, message)
      if (messages[jid].length > MAX_MESSAGES_PER_CHAT) {
        messages[jid] = messages[jid].slice(0, MAX_MESSAGES_PER_CHAT)
      }
    }
  }

  function bind(ev, opts = { groupMetadata: () => null }) {
    ev.on('connection.update', update => {
      Object.assign(state, update)
    })

    ev.on('chats.set', function store(chatsSet) {
      for (const chat of chatsSet.chats) {
        const id = chat.id?.decodeJid?.()
        if (!id) continue
        if (!(id in chats)) chats[id] = { ...chat, isChats: true, ...(chat.name ? { name: chat.name } : {}) }
        if (chat.name) chats[id].name = chat.name
      }
    })

    ev.on('contacts.set', function store(contactsSet) {
      for (const contact of contactsSet.contacts) {
        const id = contact.id?.decodeJid?.()
        if (!id) continue
        chats[id] = Object.assign(chats[id] || {}, { ...contact, isContact: true })

        const lid = contact.lid || contact.linkedIdentity
        if (lid && lid.endsWith('@lid') && id.endsWith('@s.whatsapp.net')) {
          if (!chats[lid]) chats[lid] = {}
          chats[lid].number = id
          chats[lid].lid = lid
          console.log(`[Store] contacts.set LID mapping: ${lid} → ${id}`)
        }
      }
    })

    ev.on('messages.set', function store(messagesSet) {
      for (const message of messagesSet.messages) {
        const jid = message.key.remoteJid?.decodeJid?.()
        if (!jid || isJidBroadcast(jid)) continue
        if (!(jid in messages)) messages[jid] = []
        upsertMessage(jid, proto.WebMessageInfo.fromObject(message), 'prepend')
      }
    })

    ev.on('contacts.update', function store(contactsUpdate) {
      for (const contact of contactsUpdate) {
        const id = contact.id?.decodeJid?.()
        if (!id) continue
        chats[id] = Object.assign(chats[id] || {}, { id, ...contact, isContact: true })

        const lid = contact.lid || contact.linkedIdentity
        if (lid && lid.endsWith('@lid') && id.endsWith('@s.whatsapp.net')) {
          if (!chats[lid]) chats[lid] = {}
          chats[lid].number = id
          chats[lid].lid = lid
          console.log(`[Store] contacts.update LID mapping: ${lid} → ${id}`)
        }
      }
    })

    ev.on('chats.upsert', async function store(chatsUpsert) {
      await Promise.all(chatsUpsert.map(async (chat) => {
        const id = chat.id?.decodeJid?.()
        if (!id || isJidBroadcast(id)) return
        if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
        const isGroup = isJidGroup(id)
        Object.assign(chats[id], { ...chat, isChats: true })
        if (isGroup && !chats[id].metadata) {
          const meta = await fetchGroupMetadata(id, opts.groupMetadata)
          Object.assign(chats[id], { metadata: meta })
          if (meta?.participants) cachePnFromParticipants(meta.participants)
        } else if (isGroup && chats[id].metadata?.participants) {
          cachePnFromParticipants(chats[id].metadata.participants)
        }
      }))
    })

    ev.on('chats.update', function store(chatsUpdate) {
      for (const chat of chatsUpdate) {
        const id = chat.id?.decodeJid?.()
        if (!id) continue
        if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
        if (chat.unreadCount) chat.unreadCount += chats[id].unreadCount || 0
        Object.assign(chats[id], { id, ...chat, isChats: true })
      }
    })

    ev.on('presence.update', function store(presenceUpdate) {
      const id = presenceUpdate.id?.decodeJid?.()
      if (!id) return
      if (!(id in chats)) chats[id] = { id, isContact: true }
      Object.assign(chats[id], presenceUpdate)
    })

    ev.on('messages.upsert', function store(messagesUpsert) {
      const { messages: newMessages, type } = messagesUpsert
      switch (type) {
        case 'append':
        case 'notify':
          for (const msg of newMessages) {
            const jid = msg.key.remoteJid?.decodeJid?.()
            if (!jid || isJidBroadcast(jid)) continue
            if (msg.messageStubType == WAMessageStubType.CIPHERTEXT) continue
            if (!(jid in messages)) messages[jid] = []
            upsertMessage(jid, proto.WebMessageInfo.fromObject(msg))

            if (type === 'notify' && !(jid in chats))
              ev.emit('chats.upsert', [{
                id: jid,
                conversationTimestamp: msg.messageTimestamp,
                unreadCount: 1,
                name: msg.pushName || msg.verifiedBizName,
              }])

            try {
              const content = msg.message?.pollUpdateMessage
                ? msg.message
                : (msg.message?.ephemeralMessage?.message?.pollUpdateMessage ? msg.message.ephemeralMessage.message : null)
              const pollUpdate = content?.pollUpdateMessage
              if (pollUpdate && opts.conn?.user?.id) {
                const creationMsgKey = pollUpdate.pollCreationMessageKey
                const creationJid = creationMsgKey?.remoteJid?.decodeJid?.() || jid
                const pollMsg = loadMessage(creationJid, creationMsgKey?.id)
                const pollEncKey = pollMsg?.message?.messageContextInfo?.messageSecret
                    || pollMsg?.messageContextInfo?.messageSecret
                if (pollMsg && pollEncKey) {
                  const meId = jidNormalizedUser(opts.conn.user.id)
                  const pollCreatorJid = getKeyAuthor(creationMsgKey, meId)
                  const voterJid = getKeyAuthor(msg.key, meId)
                  try {
                    const voteMsg = decryptPollVote(pollUpdate.vote, {
                      pollEncKey: pollEncKey.type === 'Buffer' ? Buffer.from(pollEncKey.data) : pollEncKey,
                      pollCreatorJid,
                      pollMsgId: creationMsgKey.id,
                      voterJid,
                    })
                    const selectedOptions = (voteMsg?.selectedOptions || []).map(o =>
                      Buffer.isBuffer(o) ? o.toString('hex') : Buffer.from(o?.data || o).toString('hex')
                    )
                    const pollOptions = pollMsg?.message?.pollCreationMessage?.options
                        || pollMsg?.message?.pollCreationMessageV2?.options
                        || pollMsg?.message?.pollCreationMessageV3?.options
                        || []
                    const optionNames = selectedOptions.map(hash => {
                      const match = pollOptions.find(o => crypto.createHash('sha256').update(o.optionName || '').digest('hex') === hash)
                      return match?.optionName || null
                    }).filter(Boolean)

                    const existing = pollMsg.pollUpdates || []
                    existing.push({
                      pollUpdateMessageKey: msg.key,
                      vote: voteMsg,
                      voter: voterJid,
                      selectedOptions: optionNames,
                      senderTimestampMs: pollUpdate.senderTimestampMs?.toNumber?.() ?? pollUpdate.senderTimestampMs
                    })
                    pollMsg.pollUpdates = existing
                    const pollJidMessages = messages[creationJid]
                    if (pollJidMessages) {
                      const idx = pollJidMessages.findIndex(m => m.key.id === creationMsgKey.id)
                      if (idx !== -1) pollJidMessages[idx].pollUpdates = existing
                    }
                  } catch (decErr) {
                  }
                }
              }
            } catch (pollErr) {
            }
          }
          break
      }
    })

    ev.on('messages.update', function store(messagesUpdate) {
      for (const message of messagesUpdate) {
        const jid = message.key.remoteJid?.decodeJid?.()
        if (!jid || isJidBroadcast(jid)) continue
        const id = message.key.id
        if (!(jid in messages)) messages[jid] = []
        const msg = loadMessage(jid, id)
        if (!msg) return
        if (message.update.messageStubType == WAMessageStubType.REVOKE) continue
        const msgIndex = messages[jid].findIndex(m => m.key.id === id)
        Object.assign(messages[jid][msgIndex], message.update)
      }
    })

    ev.on('groups.update', async function store(groupsUpdate) {
      await Promise.all(groupsUpdate.map(async (group) => {
        const id = group.id?.decodeJid?.()
        if (!id || !isJidGroup(id)) return
        if (!(id in chats)) chats[id] = { id, ...group, isChats: true }
        if (!chats[id].metadata) {
          const meta = await fetchGroupMetadata(id, opts.groupMetadata)
          Object.assign(chats[id], { metadata: meta })
          if (meta?.participants) cachePnFromParticipants(meta.participants)
        }
        Object.assign(chats[id].metadata, group)
        if (chats[id].metadata?.participants) cachePnFromParticipants(chats[id].metadata.participants)
      }))
    })

    ev.on('group-participants.update', async function store(groupParticipantsUpdate) {
      const id = groupParticipantsUpdate.id?.decodeJid?.()
      if (!id || !isJidGroup(id)) return
      if (!(id in chats)) chats[id] = { id }
      if (!chats[id].metadata) Object.assign(chats[id], { metadata: await fetchGroupMetadata(id, opts.groupMetadata) })
      const metadata = chats[id].metadata
      if (!metadata) return console.log(`Try to update group ${id} but metadata not found in 'group-participants.update'`)
      switch (groupParticipantsUpdate.action) {
        case 'add':
          metadata.participants.push(...groupParticipantsUpdate.participants.map(id => ({ id, admin: null })))
          cachePnFromParticipants(groupParticipantsUpdate.participants.map(id =>
            typeof id === 'object' ? id : { id }
          ))
          break
        case 'demote':
        case 'promote':
          for (const participant of metadata.participants)
            if (groupParticipantsUpdate.participants.includes(participant.id))
              participant.admin = groupParticipantsUpdate.action === 'promote' ? 'admin' : null
          break
        case 'remove':
          metadata.participants = metadata.participants.filter(p => !groupParticipantsUpdate.participants.includes(p.id))
          break
      }
      Object.assign(chats[id], { metadata })
    })

    ev.on('message-receipt.update', function store(messageReceiptUpdate) {
      for (const { key, receipt } of messageReceiptUpdate) {
        const jid = key.remoteJid?.decodeJid?.()
        if (!jid) continue
        if (!(jid in messages)) messages[jid] = []
        const msg = loadMessage(jid, key.id)
        if (!msg) return
        updateMessageWithReceipt(msg, receipt)
      }
    })

    ev.on('messages.reaction', function store(reactions) {
      for (const { key, reaction } of reactions) {
        const jid = key.remoteJid?.decodeJid?.()
        if (!jid) continue
        const msg = loadMessage(jid, key.id)
        if (!msg) return
        updateMessageWithReaction(msg, reaction)
      }
    })
  }

  function toJSON() {
    return { chats, messages }
  }

  function fromJSON(json) {
    Object.assign(chats, json.chats)
    for (const jid in json.messages)
      messages[jid] = json.messages[jid]
        .map(m => m && proto.WebMessageInfo.fromObject(m))
        .filter(m => m && m.messageStubType != WAMessageStubType.CIPHERTEXT)
  }

  let storeDb = null
  function getStoreDb(dbPath) {
    if (storeDb) return storeDb
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    storeDb = new DatabaseSync(dbPath)
    storeDb.exec(`
      CREATE TABLE IF NOT EXISTS store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `)
    return storeDb
  }

  function writeToFile(dbPath) {
    const conn = getStoreDb(dbPath)
    const json = JSON.stringify(toJSON(), (key, value) => key == 'isChats' ? undefined : value)
    conn.prepare('INSERT INTO store (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(json)
  }

  function readFromFile(dbPath) {
    const conn = getStoreDb(dbPath)
    const row = conn.prepare('SELECT data FROM store WHERE id = 1').get()
    if (row) fromJSON(JSON.parse(row.data))
  }

  return {
    chats,
    messages,
    state,

    loadMessage,
    fetchGroupMetadata,
    getContact,
    getNumberFromLid,
    getLidFromNumber,

    bind,
    writeToFile,
    readFromFile
  }
}

function JSONreplacer(key, value) {
  if (value == null) return
  return BufferJSON.replacer(key, value)
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

const KEY_MAP = {
  'pre-key': 'preKeys',
  'session': 'sessions',
  'sender-key': 'senderKeys',
  'app-state-sync-key': 'appStateSyncKeys',
  'app-state-sync-version': 'appStateVersions',
  'sender-key-memory': 'senderKeyMemory',
  'lid-mapping': 'lidMappings',
  'device-list': 'deviceLists',
  'tctoken': 'tcTokens'
}

function safeErr(err) {
  if (err instanceof Error) return err.stack || err.message
  return typeof err === 'string' ? err : (err?.message || String(err))
}

function applyCustomPairingCodePatch(creds) {
  const raw = global.settings?.connection?.main?.paircode
  if (!raw) return null

  const sanitized = String(raw).trim().toUpperCase()

  if (sanitized.length !== 8) {
    console.warn(
      chalk.yellow('[CUSTOM_PAIRING]'),
      `Ignored: must be exactly 8 characters (got ${sanitized.length}). Falling back to random pairing code.`
    )
    return null
  }

  if (creds && typeof creds === 'object') {
    creds.pairingCode = sanitized
  }
  return sanitized
}

function useSQLiteAuthState(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS creds (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keys (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (type, id)
    );
  `)

  const clearAuthKeys = () => {
    const result = db.prepare('DELETE FROM keys').run()
    return result.changes
  }

  const readCreds = () => {
    const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
    return row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds()
  }

  const writeCreds = (creds) => {
    db.prepare('INSERT INTO creds (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(creds, JSONreplacer))
  }

  let creds = readCreds()

  const getStmt = db.prepare('SELECT data FROM keys WHERE type = ? AND id = ?')
  const setStmt = db.prepare('INSERT INTO keys (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data')
  const delStmt = db.prepare('DELETE FROM keys WHERE type = ? AND id = ?')

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === type) || type

          const lockKeys = ids.map(id => `${dbType}:${id}`)
          return signalKeyLock.runMany(lockKeys, async () => {
            const result = {}
            for (const id of ids) {
              const row = getStmt.get(dbType, id)
              if (row) result[id] = JSON.parse(row.data, BufferJSON.reviver)
            }
            return result
          })
        },
        set: async (data) => {
          const lockKeys = []
          for (const category in data) {
            const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
            for (const id in data[category]) lockKeys.push(`${dbType}:${id}`)
          }
          return signalKeyLock.runMany(lockKeys, async () => {
            for (const category in data) {
              const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
              for (const id in data[category]) {
                const value = data[category][id]
                if (value) setStmt.run(dbType, id, JSON.stringify(value, JSONreplacer))
                else delStmt.run(dbType, id)
              }
            }
          })
        }
      }
    },
    saveCreds: async () => writeCreds(creds),
    clearAuthKeys
  }
}

function useSingleFileAuthState(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const readAll = () => {
    if (!fs.existsSync(filePath)) return { creds: initAuthCreds(), keys: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'), BufferJSON.reviver)
      return { creds: parsed.creds || initAuthCreds(), keys: parsed.keys || {} }
    } catch (e) {
      console.warn('Single-file auth state failed to parse, starting fresh:', e.message)
      return { creds: initAuthCreds(), keys: {} }
    }
  }

  let { creds, keys } = readAll()

  const persist = () => {
    fs.writeFileSync(filePath, JSON.stringify({ creds, keys }, JSONreplacer))
  }

  const clearAuthKeys = () => {
    const count = Object.values(keys).reduce((sum, byType) => sum + Object.keys(byType).length, 0)
    keys = {}
    persist()
    return count
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === type) || type
          const lockKeys = ids.map(id => `${dbType}:${id}`)
          return signalKeyLock.runMany(lockKeys, async () => {
            const result = {}
            for (const id of ids) {
              const raw = keys[dbType]?.[id]
              if (raw !== undefined) result[id] = raw
            }
            return result
          })
        },
        set: async (data) => {
          const lockKeys = []
          for (const category in data) {
            const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
            for (const id in data[category]) lockKeys.push(`${dbType}:${id}`)
          }
          return signalKeyLock.runMany(lockKeys, async () => {
            for (const category in data) {
              const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
              if (!keys[dbType]) keys[dbType] = {}
              for (const id in data[category]) {
                const value = data[category][id]
                if (value) keys[dbType][id] = value
                else delete keys[dbType][id]
              }
            }
            persist()
          })
        }
      }
    },
    saveCreds: async () => persist(),
    clearAuthKeys
  }
}

async function resolveAuthState(type, relativePath) {
  const baseDir = path.join(process.cwd(), 'data', 'sessions')

  if (type === 'multi') {
    const dir = path.join(baseDir, relativePath)
    fs.mkdirSync(dir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(dir)

    const clearAuthKeys = () => {
      const entries = fs.readdirSync(dir).filter(f => f !== 'creds.json')
      for (const f of entries) fs.unlinkSync(path.join(dir, f))
      return entries.length
    }
    return { state, saveCreds, clearAuthKeys }
  }

  if (type === 'single') {
    return useSingleFileAuthState(path.join(baseDir, `${relativePath}.json`))
  }

  return useSQLiteAuthState(path.join(baseDir, `${relativePath}.session`))
}

const rl       = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

const authState = await resolveAuthState(global.settings.connection?.main?.type || 'sql', 'main')

const store     = makeInMemoryStore()
const storeFile = 'data/sessions/store.db'

try {
  store.readFromFile(storeFile)
} catch (e) {
  console.warn('Store failed to read store file, starting with empty store:', e.message)
}

const logger = Helper.P({
  level: 'silent',
  timestamp: () => `,"time":"${new Date().toJSON()}"`
}).child({ class: 'baileys' })

async function fetchVersionWithTimeout(timeoutMs = 8000) {
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timeout')), timeoutMs))
    ])
    return result
  } catch (e) {
    console.warn(chalk.yellow('Baileys version fetch failed, using bundled default:'), safeErr(e))
    return { version: undefined, isLatest: false }
  }
}

const { version, isLatest } = await fetchVersionWithTimeout()

const connectionOptions = {
  printQRInTerminal: false,
  auth: authState.state,
  logger,
  version,
  browser: global.settings.connection.main.browser,
  connectTimeoutMs: 60000,
  keepAliveIntervalMs: 15000,
  retryRequestDelayMs: 500,
  syncFullHistory: !!global.settings.connection.main.loadhistory,
  markOnlineOnConnect: !!global.settings.system.online,
}

let pairingCodeRequested = false
let isReconnecting = false
let isPairingInProgress = false
let connGeneration = 0
let conns = new Map();

const extraConnectionListeners = new Set()

function onConnectionUpdate(handler) {
  extraConnectionListeners.add(handler)
  return () => extraConnectionListeners.delete(handler)
}

async function start(oldSocket = null, opts = { store, logger, authState }) {
  connGeneration++
  const myGeneration = connGeneration

  applyCustomPairingCodePatch(opts.authState.state.creds)

  let conn = makeWASocket({
    ...connectionOptions,
    ...opts.connectionOptions,
    logger: opts.logger,
    auth: {
      creds: opts.authState.state.creds,
      keys: makeCacheableSignalKeyStore(opts.authState.state.keys, opts.logger),
    },
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
    getMessage: async (key) => {
      const found = opts.store.loadMessage(key.remoteJid, key.id) || opts.store.loadMessage(key.id)
      return found?.message ?? undefined
    },
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.buttonsMessage ||
        message.templateMessage ||
        message.listMessage
      )
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        }
      }
      return message
    },
  })

  conn.profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
    const targetJid = conn.decodeJid ? conn.decodeJid(jid) : jid
    const result = await conn.query(
      {
        tag: 'iq',
        attrs: {
          target: targetJid,
          to: '@s.whatsapp.net',
          type: 'get',
          xmlns: 'w:profile:picture',
        },
        content: [{ tag: 'picture', attrs: { type, query: 'url' } }],
      },
      timeoutMs
    )
    const child = result?.content?.find?.(n => n.tag === 'picture')
    return child?.attrs?.url
  }

  conn.generation = myGeneration

  HelperConnection(conn, { store: opts.store, logger })

  if (oldSocket) {
    conn.isInit       = oldSocket.isInit
    conn.isReloadInit = oldSocket.isReloadInit
  }
  if (conn.isInit == null) {
    conn.isInit       = false
    conn.isReloadInit = true
  }

  store.bind(conn.ev, { groupMetadata: conn.groupMetadata, conn })

  await reload(conn, false, opts)

  return conn
}

let OldHandler = null

async function reload(conn, restartConnection, opts = { store, authState }) {
  if (!opts.handler) opts.handler = Helper.importFile(Helper.__filename(resolve('./lib/utils/handler.js'))).catch(err => console.error(safeErr(err)))
  if (opts.handler instanceof Promise) opts.handler = await opts.handler
  if (!opts.handler && OldHandler) opts.handler = OldHandler
  OldHandler = opts.handler

  const isReloadInit = !!conn.isReloadInit
  if (restartConnection) {
    try {
      const ws = conn.ws?.socket ?? conn.ws
      if (ws && ws.readyState !== ws.CLOSED) {
        await new Promise(resolve => {
          const done = () => resolve()
          ws.once?.('close', done)
          conn.ws.close()
          setTimeout(done, 2000)
        })
      } else {
        conn.ws.close()
      }
    } catch {}
    conn.ev.removeAllListeners()

    await new Promise(resolve => setTimeout(resolve, 3000))

    Object.assign(conn, await start(conn, opts) || {})
    return true
  }

  Object.assign(conn, getMessageConfig())

  if (conn.handler)            conn.ev.off('messages.upsert', conn.handler)
  if (conn.participantsUpdate) conn.ev.off('group-participants.update', conn.participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.off('groups.update', conn.groupsUpdate)
  if (conn.onDelete)           conn.ev.off('messages.delete', conn.onDelete)
  if (conn.connectionUpdate)   conn.ev.off('connection.update', conn.connectionUpdate)
  if (conn.credsUpdate)        conn.ev.off('creds.update', conn.credsUpdate)

  if (opts.handler) {
    const rawHandler = opts.handler.handler.bind(conn)
    const startEpoch = Math.floor(Date.now() / 1000)

    conn.handler = async (chatUpdate) => {
      if (chatUpdate?.messages) {
        chatUpdate.messages = chatUpdate.messages.filter((msg) => {
          const ts = typeof msg.messageTimestamp === 'object'
            ? msg.messageTimestamp?.low
            : msg.messageTimestamp
          return !ts || ts >= startEpoch
        })
        if (chatUpdate.messages.length === 0) return
      }
      return rawHandler(chatUpdate)
    }

    conn.participantsUpdate = opts.handler.participantsUpdate.bind(conn)
    conn.groupsUpdate       = opts.handler.groupsUpdate.bind(conn)
    conn.onDelete           = opts.handler.deleteUpdate.bind(conn)
  }

  if (!opts.isChild) conn.connectionUpdate = connectionUpdate.bind(conn, opts)
  conn.credsUpdate = opts.authState.saveCreds.bind(conn)

  if (conn.handler)            conn.ev.on('messages.upsert', conn.handler)
  if (conn.participantsUpdate) conn.ev.on('group-participants.update', conn.participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.on('groups.update', conn.groupsUpdate)
  if (conn.onDelete)           conn.ev.on('messages.delete', conn.onDelete)
  if (!opts.isChild) {
    if (conn.connectionUpdate) conn.ev.on('connection.update', conn.connectionUpdate)
  }
  if (typeof conn.credsUpdate === 'function') conn.ev.on('creds.update', conn.credsUpdate)

  conn.isReloadInit = false
  return true
}

async function connectionUpdate(opts, update) {
  const { connection, lastDisconnect, isNewLogin, qr } = update

  if (connection) {
    console.log(`Connection` + chalk.gray(` ${connection}`))
  }

  for (const listener of extraConnectionListeners) {
    try {
      listener(update)
    } catch (err) {
      console.error(chalk.red('connection.update listener error:'), safeErr(err))
    }
  }

  if (connection === 'open') {
    this.isSocketReady = false
    setTimeout(() => { this.isSocketReady = true }, 3000)
  }
  if (connection === 'close') {
    this.isSocketReady = false
  }

  if (qr && !pairingCodeRequested && !isPairingInProgress) {
    pairingCodeRequested = true
    isPairingInProgress = true
    const myGeneration = this.generation

    ;(async () => {
      try {
        console.log(chalk.yellow('\nSocket ready, requesting pairing code from WhatsApp...'))

        const pairFlag  = Helper.opts['pair']
        const phoneNumber = pairFlag
          ? String(pairFlag).trim()
          : (await question('Enter your WhatsApp number (example: 1305xxxx):\n')).trim()

        if (myGeneration !== connGeneration) {
          console.warn(chalk.yellow('Pairing cancelled, connection was replaced'))
          return
        }

        const customPairing = String(global.settings.connection.main.paircode).trim().toUpperCase()

        const pairingCode = await this.requestPairingCode(phoneNumber, customPairing)

        if (myGeneration !== connGeneration) {
          console.warn(chalk.yellow('Pairing cancelled, connection was replaced'))
          return
        }

        if (pairingCode) {
          const formattedCode = pairingCode.length === 8
            ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}`
            : pairingCode
          console.log(chalk.bold(`~> ${formattedCode}`))
        } else {
          console.warn(chalk.yellow('Did not receive pairing code, please try again'))
          pairingCodeRequested = false
        }
      } catch (error) {
        console.error(chalk.red('Error getting pairing code:'), safeErr(error))
        console.log('• Make sure the WhatsApp number is correct and try again.')
        pairingCodeRequested = false
      } finally {
        isPairingInProgress = false
      }
    })()
  }

  const code = lastDisconnect?.error?.output?.statusCode
    || lastDisconnect?.error?.output?.payload?.statusCode

  if (connection === 'close') {
    const reasonMsg = lastDisconnect?.error?.output?.payload?.message
      || lastDisconnect?.error?.message
      || '(no message)'
    console.log(chalk.red('[ DisconnectReal ]') + chalk.gray(` code=${code} message=${reasonMsg}`))
  }

  const NON_RECOVERABLE = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
  ])

  const shouldReconnect = connection === 'close' && !NON_RECOVERABLE.has(code)

  if (shouldReconnect) {
    if (isReconnecting) {
      console.log(chalk.yellow('Reconnect') + chalk.gray(' is running, skip...'))
      return
    }
    if (isPairingInProgress && this.generation === connGeneration) {
      console.log(chalk.yellow('Reconnect') + chalk.gray(' delayed, pairing in progress...'))
      return
    }
    isReconnecting = true

    try {
      const retryDelay = code === DisconnectReason.connectionLost ? 1000 : 3000
      await new Promise(resolve => setTimeout(resolve, retryDelay))
      await reload(this, true, opts).catch(err => console.error(chalk.red('Reload error:'), safeErr(err)))

      if (global?.timestamp) global.timestamp.connect = new Date()

      pairingCodeRequested = false
    } finally {
      isReconnecting = false
    }
  }

  if (connection === 'open') {
    isReconnecting = false

    const onBotOpen = global.onBotOpen
    if (typeof onBotOpen === 'function') {
      global.onBotOpen = null
      Promise.resolve().then(onBotOpen).catch(e => console.error('Tunnel setup error:', safeErr(e)))
    }

    setTimeout(() => {
      global.restartTunnel?.().catch(e => console.error('Tunnel restartTunnel error:', safeErr(e)))
    }, 5000)
  }

  if (db.data == null) {
    await loadDatabase().catch(e => console.error('DB loadDatabase error:', safeErr(e)))
  }
}

async function forceReconnect(conn, opts, reason = 'forced') {
  if (isReconnecting) {
    console.log(chalk.yellow('Reconnect') + chalk.gray(' is running, skip... (forced trigger ignored)'))
    return false
  }
  if (isPairingInProgress) {
    console.log(chalk.yellow('Reconnect') + chalk.gray(' delayed, pairing in progress... (forced trigger ignored)'))
    return false
  }
  isReconnecting = true
  console.log(chalk.red('Reconnect') + chalk.gray(` forcing reload (reason: ${reason})`))
  const MAX_ATTEMPTS = 3
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try {
        await reload(conn, true, opts)
        if (global?.timestamp) global.timestamp.connect = new Date()
        pairingCodeRequested = false
        return true
      } catch (err) {
        console.error(chalk.red('Reload error:') + chalk.gray(` (attempt ${attempt}/${MAX_ATTEMPTS})`), safeErr(err))
        if (attempt === MAX_ATTEMPTS) {
          console.error(chalk.red('Reconnect') + chalk.gray(` gave up after ${MAX_ATTEMPTS} failed attempts — falling back to a full process restart.`))
          setTimeout(() => process.emit('force-exit-for-restart'), 200)
          return false
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      }
    }
  } finally {
    isReconnecting = false
  }
}

function getMessageConfig() {
  return {
    welcome:  'Hi @user!\nWelcome to @subject',
    bye:      'Good bye @user!',
    spromote: '@user is now admin',
    sdemote:  '@user is no longer admin',
    sDesc:    'Description changed\n\n@desc',
    sSubject: 'Group subject changed\n\n@subject',
    sIcon:    'Group icon changed',
    sRevoke:  'Group link has been changed'
  }
}

const conn = start(null, { store, logger, authState })
  .catch(err => console.error(chalk.red('Start error:'), safeErr(err)))

conn.then(async () => {
  if (db.data == null) {
    await loadDatabase().catch(e => console.error('DB loadDatabase error:', safeErr(e)))
  }
  import('../../plugins/subbot/connect.js')
    .then(({ autoConnectSubBots }) => autoConnectSubBots())
    .catch(err => console.error('[Subbot] Autoconnect error:', safeErr(err)))
})

function sessionStoragePath(type, relativePath) {
  const baseDir = path.join(process.cwd(), 'data', 'sessions')
  if (type === 'multi') return path.join(baseDir, relativePath)
  if (type === 'single') return path.join(baseDir, `${relativePath}.json`)
  return path.join(baseDir, `${relativePath}.session`)
}

function hasSavedAuthState(type, relativePath) {
  const target = sessionStoragePath(type, relativePath)
  if (!fs.existsSync(target)) return false
  try {
    if (type === 'multi') {
      const credsFile = path.join(target, 'creds.json')
      if (!fs.existsSync(credsFile)) return false
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'), BufferJSON.reviver)
      return !!creds?.registered
    }
    if (type === 'single') {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'), BufferJSON.reviver)
      return !!parsed?.creds?.registered
    }
    const db = new DatabaseSync(target, { readOnly: true })
    const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
    db.close()
    if (!row) return false
    return !!JSON.parse(row.data, BufferJSON.reviver)?.registered
  } catch {
    return false
  }
}

function removeSavedAuthState(type, relativePath) {
  const target = sessionStoragePath(type, relativePath)
  if (!fs.existsSync(target)) return
  if (type === 'multi') {
    fs.rmSync(target, { recursive: true, force: true })
  } else {
    fs.rmSync(target, { force: true })
  }
}

export default {
  start,
  reload,
  forceReconnect,
  onConnectionUpdate,
  conn,
  conns,
  logger,
  connectionOptions,
  storeFile,
  authState,
  store,
  getMessageConfig,
  resolveAuthState,
  sessionStoragePath,
  hasSavedAuthState,
  removeSavedAuthState
}

export { conn, conns, logger, forceReconnect, onConnectionUpdate, resolveAuthState, sessionStoragePath, hasSavedAuthState, removeSavedAuthState }