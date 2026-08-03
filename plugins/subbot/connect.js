const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers,
    areJidsSameUser
} = await import("baileys")

import fs from 'fs'
import P from 'pino'
import Connection from '../../lib/connection.js'
import { HelperConnection } from '../../lib/simple.js'

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

export function sessionPath(jid) {
    return `${getSubbotConfig().base}/${jid}`
}

export function hasSavedSession(jid) {
    return fs.existsSync(`${sessionPath(jid)}/creds.json`)
}

export function listSavedSessionJids() {
    const { base } = getSubbotConfig()
    if (!fs.existsSync(base)) return []
    return fs.readdirSync(base).filter(name => hasSavedSession(name))
}

export function removeSavedSession(jid) {
    const path = sessionPath(jid)
    if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}

export async function startSubBot(jid, opts = {}) {
    const path = sessionPath(jid)
    fs.mkdirSync(path, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(path)
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
                fs.rmSync(path, { recursive: true, force: true })
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

    const { max, autoConnect } = getSubbotConfig()
    if (!autoConnect) return

    const jids = listSavedSessionJids().slice(0, max)
    if (jids.length === 0) return

    console.log(`[Jadibot] Auto-reconnecting ${jids.length} saved session(s)...`)

    for (const jid of jids) {
        if (Connection.conns.has(jid)) continue

        startSubBot(jid, {
            onOpen: (subConn) => {
                console.log(`[Jadibot] Auto-reconnected: ${subConn.user?.id?.split('@')[0] || jid.split('@')[0]}`)
            },
            onReconnecting: () => {
                console.log(`[Jadibot] Reconnecting: ${jid.split('@')[0]}`)
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

    const path = sessionPath(m.sender)

    if (args[0]) {
        try {
            const credsJson = JSON.parse(Buffer.from(args[0], 'base64').toString('utf-8'))
            fs.mkdirSync(path, { recursive: true })
            fs.writeFileSync(`${path}/creds.json`, JSON.stringify(credsJson, null, '\t'))
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
    removeSavedSession(foundKey)
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
