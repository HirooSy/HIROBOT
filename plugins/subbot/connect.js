const {
    makeWASocket,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers,
    areJidsSameUser,
    BufferJSON,
    initAuthCreds
} = await import("baileys")

import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import P from 'pino'
import Connection from '../../lib/connection.js'
import { HelperConnection } from '../../lib/simple.js'
import db, { loadDatabase, getUserAutoReconnect as dbGetUserAutoReconnect, setUserAutoReconnect as dbSetUserAutoReconnect } from '../../lib/database.js'

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

    const replacer = (key, value) => value == null ? undefined : BufferJSON.replacer(key, value)

    const readCreds = () => {
        const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
        return row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds()
    }
    const writeCreds = (creds) => {
        db.prepare('INSERT INTO creds (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
            .run(JSON.stringify(creds, replacer))
    }

    const creds = readCreds()
    const getStmt = db.prepare('SELECT data FROM keys WHERE type = ? AND id = ?')
    const setStmt = db.prepare('INSERT INTO keys (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data')
    const delStmt = db.prepare('DELETE FROM keys WHERE type = ? AND id = ?')

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === type) || type
                    const result = {}
                    for (const id of ids) {
                        const row = getStmt.get(dbType, id)
                        if (row) result[id] = JSON.parse(row.data, BufferJSON.reviver)
                    }
                    return result
                },
                set: async (data) => {
                    for (const category in data) {
                        const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
                        for (const id in data[category]) {
                            const value = data[category][id]
                            if (value) setStmt.run(dbType, id, JSON.stringify(value, replacer))
                            else delStmt.run(dbType, id)
                        }
                    }
                }
            }
        },
        saveCreds: async () => writeCreds(creds)
    }
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // kept for reference only, no longer enforced

function sanitizeCustomPairingCode(raw, { silent = false } = {}) {
    if (!raw) return null
    const sanitized = String(raw).trim().toUpperCase()

    if (sanitized.length !== 8) {
        if (!silent) console.warn(`[CUSTOM_PAIRING] Ignored: must be exactly 8 characters (got ${sanitized.length}).`)
        return null
    }
    return sanitized
}

async function fetchVersionWithTimeout(timeoutMs = 8000) {
    try {
        return await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timeout')), timeoutMs))
        ])
    } catch (e) {
        console.warn('[Subbot] Baileys version fetch failed, using bundled default:', e?.message || e)
        return { version: undefined, isLatest: false }
    }
}

export function getSubbotConfig() {
    const cfg = global.settings?.subbot || {}
    return {
        base: cfg.path || 'data/sessions/subbot',
        max: cfg.maxConnect ?? 3,
        autoConnect: cfg.autoConnect ?? true,
    }
}

async function setUserAutoReconnect(jid, value) {
    return dbSetUserAutoReconnect(jid, value)
}

function getUserAutoReconnect(jid) {
    return dbGetUserAutoReconnect(jid, getSubbotConfig().autoConnect)
}

export function sessionPath(jid) {
    return `${getSubbotConfig().base}/${jid}.data`
}

export function hasSavedSession(jid) {
    const dbPath = sessionPath(jid)
    if (!fs.existsSync(dbPath)) return false
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
        db.close()
        if (!row) return false
        return !!JSON.parse(row.data)?.registered
    } catch {
        return false
    }
}

export function listSavedSessionJids() {
    const { base } = getSubbotConfig()
    if (!fs.existsSync(base)) return []
    return fs.readdirSync(base)
        .filter(name => name.endsWith('.data'))
        .map(name => name.slice(0, -'.data'.length))
        .filter(jid => hasSavedSession(jid))
}

export function removeSavedSession(jid) {
    const dbPath = sessionPath(jid)
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true })
}

export async function startSubBot(jid, opts = {}) {
    const dbPath = sessionPath(jid)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    const { state, saveCreds } = useSQLiteAuthState(dbPath)
    const { version } = await fetchVersionWithTimeout()
    const logger = P({ level: 'silent' })

    let isReconnecting = false
    let connGeneration = 0

    function buildSocketOptions() {
        const customPairing = sanitizeCustomPairingCode(process.env.CUSTOM_PAIRING)
        if (customPairing) state.creds.pairingCode = customPairing

        return {
            printQRInTerminal: false,
            mobile: false,
            version,
            browser: opts.browser || Browsers.ubuntu('Firefox'),
            generateHighQualityLinkPreview: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 500,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
        }
    }

    let subConn = makeWASocket(buildSocketOptions())
    HelperConnection(subConn, { store: Connection.store, logger })
    subConn.isInit = false
    subConn.authState = state
    let isInit = true

    async function reloadHandler(restartConn = false) {
        connGeneration++
        const myGeneration = connGeneration

        let Handler
        try {
            Handler = await import(`../../lib/handler.js?t=${Date.now()}`).catch(console.error)
        } catch (e) {
            console.error(e)
        }

        if (restartConn) {
            try { subConn.ws.close() } catch {}
            subConn.ev.removeAllListeners()
            subConn = makeWASocket(buildSocketOptions())
            HelperConnection(subConn, { store: Connection.store, logger })
            subConn.authState = state
            isInit = true
        }

        if (myGeneration !== connGeneration) return false

        if (!isInit) {
            if (subConn.handler)            subConn.ev.off('messages.upsert', subConn.handler)
            if (subConn.participantsUpdate) subConn.ev.off('group-participants.update', subConn.participantsUpdate)
            if (subConn.groupsUpdate)        subConn.ev.off('groups.update', subConn.groupsUpdate)
            if (subConn.onDelete)            subConn.ev.off('messages.delete', subConn.onDelete)
            if (subConn.connectionUpdate)    subConn.ev.off('connection.update', subConn.connectionUpdate)
            if (subConn.credsUpdate)         subConn.ev.off('creds.update', subConn.credsUpdate)
        }

        Object.assign(subConn, Connection.getMessageConfig())

        if (Handler) {
            const rawHandler = Handler.handler.bind(subConn)
            const startEpoch = Math.floor(Date.now() / 1000)

            subConn.handler = async (chatUpdate) => {
                if (chatUpdate?.messages) {
                    chatUpdate.messages = chatUpdate.messages.filter(msg => {
                        const ts = typeof msg.messageTimestamp === 'object'
                            ? msg.messageTimestamp?.low
                            : msg.messageTimestamp
                        return !ts || ts >= startEpoch
                    })
                    if (chatUpdate.messages.length === 0) return
                }
                return rawHandler(chatUpdate)
            }

            subConn.participantsUpdate = Handler.participantsUpdate.bind(subConn)
            subConn.groupsUpdate       = Handler.groupsUpdate.bind(subConn)
            subConn.onDelete           = Handler.deleteUpdate.bind(subConn)
        }

        subConn.connectionUpdate = connectionUpdate
        subConn.credsUpdate      = saveCreds

        if (subConn.handler)            subConn.ev.on('messages.upsert', subConn.handler)
        if (subConn.participantsUpdate) subConn.ev.on('group-participants.update', subConn.participantsUpdate)
        if (subConn.groupsUpdate)       subConn.ev.on('groups.update', subConn.groupsUpdate)
        if (subConn.onDelete)           subConn.ev.on('messages.delete', subConn.onDelete)
        subConn.ev.on('connection.update', subConn.connectionUpdate)
        subConn.ev.on('creds.update', subConn.credsUpdate)

        isInit = false
        return true
    }

    async function connectionUpdate(update) {
        const { connection, lastDisconnect } = update
        if (!connection) return

        if (connection === 'open') {
            subConn.isInit = true
            Connection.conns.set(jid, subConn)
            await opts.onOpen?.(subConn)
            return
        }

        if (connection === 'close') {
            Connection.conns.delete(jid)

            const statusCode = lastDisconnect?.error?.output?.statusCode
                || lastDisconnect?.error?.output?.payload?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut

            if (loggedOut) {
                fs.rmSync(dbPath, { force: true })
                await opts.onClose?.(subConn, statusCode, true)
                return
            }

            if (statusCode) {
                if (isReconnecting) return
                isReconnecting = true

                try {
                    await opts.onReconnecting?.(subConn)
                    const retryDelay = statusCode === DisconnectReason.connectionLost ? 1000 : 3000
                    await new Promise(resolve => setTimeout(resolve, retryDelay))
                    await reloadHandler(true).catch(err => console.error('[Subbot] Reload error:', err))
                } finally {
                    isReconnecting = false
                }
                return
            }

            await opts.onClose?.(subConn, statusCode, false)
        }
    }

    await reloadHandler(false)
    return {
        get subConn() { return subConn },
        requestPairingCode: (phone, customCode) => subConn.requestPairingCode(
            phone,
            sanitizeCustomPairingCode(customCode ?? process.env.CUSTOM_PAIRING) || undefined
        )
    }
}

let hasAutoConnected = false

export async function autoConnectSubBots() {
    if (hasAutoConnected) return
    hasAutoConnected = true

    if (db.data == null) {
        await loadDatabase().catch(e => console.error('[Subbot] loadDatabase error:', e))
    }

    const { max, autoConnect } = getSubbotConfig()
    if (!autoConnect) return

    const jids = listSavedSessionJids()
        .filter(jid => getUserAutoReconnect(jid))
        .slice(0, max)
    if (jids.length === 0) return

    console.log(`[subbot] Auto-reconnecting ${jids.length} saved session(s)...`)

    for (const jid of jids) {
        if (Connection.conns.has(jid)) continue

        startSubBot(jid, {
            onOpen: (subConn) => {
                console.log(`[subbot] Auto-reconnected: ${subConn.user?.id?.split('@')[0] || jid.split('@')[0]}`)
            },
            onReconnecting: () => {
                console.log(`[subbot] Reconnecting: ${jid.split('@')[0]}`)
            },
            onClose: (_subConn, statusCode, loggedOut) => {
                console.log(loggedOut
                    ? `[Subbot] Session logged out and removed: ${jid.split('@')[0]}`
                    : `[Subbot] Session closed: ${jid.split('@')[0]}`)
            },
        }).catch(err => console.error(`[Subbot] Failed to auto-reconnect ${jid.split('@')[0]}:`, err))
    }
}

async function doConnect(m, { conn, usedPrefix, isPrems }) {
    if (!isPrems) throw `❌ This command is for premium users only.`

    const parentConn = await Connection.conn
    const { max } = getSubbotConfig()

    if (m.sender === parentConn.user.id) {
        return m.reply(`❌ Cannot create *Session* on ${parentConn.user.id.split('@')[0]}`)
    }
    if (Connection.conns.has(m.sender)) {
        return m.reply(`⚠️ You already have an active *Session*.\nUse *${usedPrefix}disconnect* to stop it first.`)
    }
    if (Connection.conns.size >= max) {
        return m.reply(`❌ Slots are full (max ${max}).\nPlease wait for a slot to be available.`)
    }
    if (hasSavedSession(m.sender)) {
        return m.reply(`⚠️ You already have a previous session.\nUse *${usedPrefix}reconnect* to continue, or delete the old session first.`)
    }

    const { subConn, requestPairingCode } = await startSubBot(m.sender, {
        onOpen: async (subConn) => {
            await setUserAutoReconnect(m.sender, true)
            await conn.reply(
                m.chat,
                `✅ *Session connected!*\n\nUse *${usedPrefix}disconnect* to stop.`,
                m,
                { mentions: [m.sender] }
            )
        },
        onReconnecting: async () => {
            await conn.reply(m.chat, `⚠️ *session* disconnected, trying to reconnect...`, m)
        },
        onClose: async (_subConn, _statusCode, loggedOut) => {
            await conn.reply(m.chat, loggedOut
                ? `❌ *Session* logged out. Session deleted.\nPlease *${usedPrefix}pairing* again.`
                : `❌ *Session* disconnected.`, m)
        },
    })

    if (!subConn.authState.creds.registered) {
        setTimeout(async () => {
            const phoneNumber = m.sender.split('@')[0]
            try {
                const code = await requestPairingCode(phoneNumber)
                await conn.reply(m.chat, `-> Code: \`${code}\``, m)
            } catch (error) {
                console.error('[MultiSession] Error requesting pairing code:', error)
                await conn.reply(m.chat, `❌ Failed to get pairing code. Try again later.\n\n_Error: ${error?.message || error}_`, m)
            }
        }, 3000)
    }
}

async function doReconnect(m, { conn, args, usedPrefix, isPrems }) {
    if (!isPrems) throw `❌ This command is for premium users only.`

    const parentConn = await Connection.conn
    const { max } = getSubbotConfig()

    if (conn.user.id !== parentConn.user.id) {
        return conn.reply(m.chat, `❌ This command can only be used from the main bot!\nwa.me/${parentConn.user.id.split('@')[0]}`, m)
    }
    if (Connection.conns.has(m.sender)) {
        return conn.reply(m.chat, `⚠️ You already have an active *Jadibot*.\nUse *${usedPrefix}disconnect* to stop it first.`, m)
    }
    if (Connection.conns.size >= max) {
        return conn.reply(m.chat, `❌ Slots are full (max ${max}).\nPlease wait for a slot to be available.`, m)
    }

    const dbPath = sessionPath(m.sender)

    if (args[0]) {
        try {
            const credsJson = JSON.parse(Buffer.from(args[0], 'base64').toString('utf-8'))
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
            db.prepare('INSERT INTO creds (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
                .run(JSON.stringify(credsJson))
            db.close()
        } catch {
            return conn.reply(m.chat, `❌ *Invalid Session ID.*\nMake sure you send the correct Session ID from *${usedPrefix}pairing*.`, m)
        }
    } else if (!hasSavedSession(m.sender)) {
        return conn.reply(
            m.chat,
            `❌ No session found for your number.\n\nUse *${usedPrefix}pairing* first to create a new session.`,
            m
        )
    }

    await conn.react(`⏳`)

    const cleanupInterval = setInterval(() => {
        const subConn = Connection.conns.get(m.sender)
        if (!subConn?.user) clearInterval(cleanupInterval)
    }, 60_000)

    await startSubBot(m.sender, {
        onOpen: async (subConn) => {
            await setUserAutoReconnect(m.sender, true)
            clearInterval(cleanupInterval)
            await m.react("✅")
        },
        onReconnecting: async () => {
            await conn.sendMessage(m.chat, { text: `⚠️ Disconnected, trying to reconnect...` }, { quoted: m })
        },
        onClose: async (_subConn, _statusCode, loggedOut) => {
            clearInterval(cleanupInterval)
            await conn.sendMessage(m.chat, {
                text: loggedOut
                    ? `❌ *Connection* logged out. Session deleted.\nUse *${usedPrefix}pairing* to create a new session.`
                    : `❌ Disconnected. Use *${usedPrefix}reconnect* to reconnect.`
            }, { quoted: m })
        },
    })
}

async function doDisconnect(m, { conn, isOwner }) {
    if (!isOwner) throw `❌ Only the bot owner can use this command.`

    let foundKey = null
    for (const [key, _conn] of Connection.conns.entries()) {
        if (areJidsSameUser(_conn.user?.id, conn.user?.id)) {
            foundKey = key
            break
        }
    }

    if (!foundKey) {
        if (areJidsSameUser((await Connection.conn).user.id, conn.user.id)) {
            throw "❌ You cannot stop the bot main session directly via this command."
        }
        throw `⚠️ This session was not found in the list of active connections.`
    }

    await conn.reply(m.chat, `Session is being stopped...`, m)

    try {
        conn.ev.removeAllListeners()
        conn.ws.close()
    } catch (e) {
        console.error('[Subbot] Error while disconnecting:', e)
    }

    Connection.conns.delete(foundKey)
    await setUserAutoReconnect(foundKey, false)
}

const handler = async (m, context) => {
    const { command } = context

    if (/^(pairing|connect)$/i.test(command)) return doConnect(m, context)
    if (/^(reconnect)$/i.test(command)) return doReconnect(m, context)
    if (/^(disconnect)$/i.test(command)) return doDisconnect(m, context)
}

handler.help = ['pairing', 'reconnect', 'disconnect']
handler.tags    = ['session']
handler.command = /^(pairing|connect|reconnect|disconnect)$/i
handler.ai      = { risk: "blocked", description: "connect, reconnect, or disconnect a WhatsApp sub-bot session" }

export default handler
