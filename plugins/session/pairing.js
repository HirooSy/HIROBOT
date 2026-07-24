const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers
} = await import("baileys")

import fs from "fs"
import pino from "pino"
import Connection from '../../lib/connection.js'
import { HelperConnection } from '../../lib/simple.js'

const SESSION_BASE = 'data/sessions/jadibot'

const handler = async (m, { conn, usedPrefix, command }) => {
    const parentConn = await Connection.conn

    if (m.sender === parentConn.user.id) {
        return m.reply(`❌ Cannot create *Session* on ${parentConn.user.id.split('@')[0]}`)
    }

    if (Connection.conns.has(m.sender)) {
        return m.reply(`⚠️ You already have an active *Sessionot*.\nUse *${usedPrefix}stopjadibot* to stop it first.`)
    }

    if (Connection.conns.size >= 3) {
        return m.reply(`❌ Slots are full (max 3).\nPlease wait for a slot to be available.`)
    }

    const sessionPath = `${SESSION_BASE}/${m.sender}`

    if (fs.existsSync(`${sessionPath}/creds.json`)) {
        return m.reply(`⚠️ You already have a previous session.\nUse *${usedPrefix}reconnect* to continue, or delete the old session first.`)
    }

    fs.mkdirSync(sessionPath, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const { version } = await fetchLatestBaileysVersion()
    const logger = pino({ level: 'silent' })

    const socketOptions = {
        printQRInTerminal: false,
        mobile: false,
        version,
        browser: Browsers.ubuntu('Firefox'),
        generateHighQualityLinkPreview: true,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
    }

    let subConn = makeWASocket(socketOptions)
    HelperConnection(subConn, { store: Connection.store, logger })
    subConn.isInit = false
    let isInit = true

    // ─── Reload / restart handler sub-bot ────────────────────────────────────
    async function creloadHandler(restartConn = false) {
        let Handler
        try {
            Handler = await import(`../../lib/handler.js?t=${Date.now()}`).catch(console.error)
        } catch (e) {
            console.error(e)
        }

        if (restartConn) {
            try { subConn.ws.close() } catch {}
            subConn.ev.removeAllListeners()
            subConn = makeWASocket(socketOptions)
            HelperConnection(subConn, { store: Connection.store, logger })
            isInit = true
        }

        if (!isInit) {
            if (subConn.handler)            subConn.ev.off('messages.upsert', subConn.handler)
            if (subConn.participantsUpdate) subConn.ev.off('group-participants.update', subConn.participantsUpdate)
            if (subConn.groupsUpdate)       subConn.ev.off('groups.update', subConn.groupsUpdate)
            if (subConn.onDelete)           subConn.ev.off('messages.delete', subConn.onDelete)
            if (subConn.connectionUpdate)   subConn.ev.off('connection.update', subConn.connectionUpdate)
            if (subConn.credsUpdate)        subConn.ev.off('creds.update', subConn.credsUpdate)
        }

        Object.assign(subConn, Connection.getMessageConfig())

        if (Handler) {
            const rawHandler = Handler.handler.bind(subConn)
            const startEpoch = Math.floor(Date.now() / 1000)

            // Skip backlog messages that Baileys delivers on reconnect (older than start time)
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

        if (subConn.handler) subConn.ev.on('messages.upsert', subConn.handler)
        if (subConn.participantsUpdate) subConn.ev.on('group-participants.update', subConn.participantsUpdate)
        if (subConn.groupsUpdate) subConn.ev.on('groups.update', subConn.groupsUpdate)
        if (subConn.onDelete) subConn.ev.on('messages.delete', subConn.onDelete)
        subConn.ev.on('connection.update', subConn.connectionUpdate)
        subConn.ev.on('creds.update', subConn.credsUpdate)

        isInit = false
        return true
    }

    // ─── Connection update sub-bot ────────────────────────────────────────────
    async function connectionUpdate(update) {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
            Connection.conns.set(m.sender, subConn)

            await conn.reply(
                m.chat,
                `✅ *Session connected!*\n\n• Owner: @${m.sender.split('@')[0]}\n• Bot account: *${subConn.user?.id?.split('@')[0] || '-'}*\n\nUse *${usedPrefix}disconnect* to stop.`,
                m,
                { mentions: [m.sender] }
            )

        } else if (connection === 'close') {
            Connection.conns.delete(m.sender)

            const statusCode = lastDisconnect?.error?.output?.statusCode
                || lastDisconnect?.error?.output?.payload?.statusCode

            if (statusCode && statusCode !== DisconnectReason.loggedOut) {
                await conn.reply(m.chat, `⚠️ *session* disconnected, trying to reconnect...`, m)
                creloadHandler(true).catch(console.error)
            } else if (statusCode === DisconnectReason.loggedOut) {
                fs.rmSync(sessionPath, { recursive: true, force: true })
                await conn.reply(m.chat, `❌ *Session* logged out. Session deleted.\nPlease *${usedPrefix}pairing* again.`, m)
            } else {
                await conn.reply(m.chat, `❌ *Session* disconnected.`, m)
            }
        }
    }

    // ─── Request pairing code (hanya jika belum registered) ──────────────────
    if (!subConn.authState.creds.registered) {
        setTimeout(async () => {
            const phoneNumber = m.sender.split('@')[0]

            try {
                const code = await subConn.requestPairingCode(phoneNumber)
                await conn.reply(m.chat, `-> Code: \`${code}\``, m)
            } catch (error) {
                console.error('[MultiSession] Error requesting pairing code:', error)
                await conn.reply(m.chat, `❌ Failed to get pairing code. Try again later.\n\n_Error: ${error?.message || error}_`, m)
            }
        }, 3000)
    }

    await creloadHandler(false)
}

handler.help    = ['pairing']
handler.tags    = ['session']
handler.command = /^(pairing)$/i
handler.premium = true
handler.ai      = { risk: "blocked", description: "send pairing code to user to turn user into sub-bot" }

export default handler
