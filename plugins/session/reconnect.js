
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers
} = await import("baileys")

import fs from "fs"
import P from 'pino'
import Connection from '../../lib/connection.js'
import { HelperConnection } from '../../lib/simple.js'

const SESSION_BASE = 'data/sessions/jadibot'

const handler = async (m, { conn, args, usedPrefix, command }) => {
    const parentConn = await Connection.conn

    if (conn.user.id !== parentConn.user.id) {
        return conn.reply(m.chat, `❌ This command can only be used from the main bot!\nwa.me/${parentConn.user.id.split('@')[0]}`, m)
    }

    // Reject if user already has an active jadibot
    if (Connection.conns.has(m.sender)) {
        return conn.reply(m.chat, `⚠️ You already have an active *Jadibot*.\nUse *${usedPrefix}stopjadibot* to stop it first.`, m)
    }

    if (Connection.conns.size >= 3) {
        return conn.reply(m.chat, `❌ Slots are full (max 3).\nPlease wait for a slot to be available.`, m)
    }

    const sessionPath = `${SESSION_BASE}/${m.sender}`

    // If Session ID (base64) provided → write to session folder
    if (args[0]) {
        try {
            const credsJson = JSON.parse(Buffer.from(args[0], 'base64').toString('utf-8'))
            fs.mkdirSync(sessionPath, { recursive: true })
            fs.writeFileSync(`${sessionPath}/creds.json`, JSON.stringify(credsJson, null, '\t'))
        } catch {
            return conn.reply(m.chat, `❌ *Invalid Session ID.*\nMake sure you send the correct Session ID from *${usedPrefix}pairing*.`, m)
        }
    } else {
        // No args → check if session folder already exists from previous pairing
        if (!fs.existsSync(`${sessionPath}/creds.json`)) {
            return conn.reply(
                m.chat,
                `❌ No session found for your number.\n\nUse *${usedPrefix}pairing* first to create a new session.`,
                m
            )
        }
    }

    await conn.reply(m.chat, `⏳ Connecting using saved session...`, m)

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const logger = P({ level: 'silent' })

    const socketOptions = {
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        // Lihat catatan di pairing.js — tuple manual diganti helper resmi
        // baileys supaya konsisten dengan bot utama & tidak di-reject WA.
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
    }

    let subConn = makeWASocket(socketOptions)
    HelperConnection(subConn, { store: Connection.store, logger })
    subConn.isInit = false
    let isInit = true

    // ─── Reload / restart handler ─────────────────────────────────────────────
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

        subConn.ev.on('messages.upsert',          subConn.handler)
        subConn.ev.on('group-participants.update', subConn.participantsUpdate)
        subConn.ev.on('groups.update',             subConn.groupsUpdate)
        subConn.ev.on('messages.delete',           subConn.onDelete)
        subConn.ev.on('connection.update',         subConn.connectionUpdate)
        subConn.ev.on('creds.update',              subConn.credsUpdate)

        isInit = false
        return true
    }

    // ─── Auto cleanup if subConn has no user after 60s ────────────────────────
    const cleanupInterval = setInterval(() => {
        if (!subConn.user) {
            try { subConn.ws.close() } catch {}
            subConn.ev.removeAllListeners()
            Connection.conns.delete(m.sender)
            clearInterval(cleanupInterval)
        }
    }, 60_000)

    // ─── Connection update ────────────────────────────────────────────────────
    async function connectionUpdate(update) {
        const { connection, lastDisconnect } = update

        const statusCode = lastDisconnect?.error?.output?.statusCode
            || lastDisconnect?.error?.output?.payload?.statusCode

        if (connection === 'open') {
            subConn.isInit = true
            Connection.conns.set(m.sender, subConn)

            await conn.sendMessage(m.chat, {
                text: `✅ *Session reconnected!*\n\n• Account: *${subConn.user?.id?.split('@')[0] || '-'}*\n• Owner: @${m.sender.split('@')[0]}`
            }, { quoted: m, mentions: [m.sender] })
        }

        if (connection === 'close') {
            Connection.conns.delete(m.sender)

            if (statusCode && statusCode !== DisconnectReason.loggedOut) {
                await conn.sendMessage(m.chat, {
                    text: `⚠️ Disconnected (code: ${statusCode}), trying to reconnect...`
                }, { quoted: m })
                creloadHandler(true).catch(console.error)

            } else if (statusCode === DisconnectReason.loggedOut) {
                clearInterval(cleanupInterval)
                fs.rmSync(sessionPath, { recursive: true, force: true })
                await conn.sendMessage(m.chat, {
                    text: `❌ *Jadibot* logged out. Session deleted.\nUse *${usedPrefix}pairing* to create a new session.`
                }, { quoted: m })

            } else {
                clearInterval(cleanupInterval)
                await conn.sendMessage(m.chat, {
                    text: `❌ Disconnected. Use *${usedPrefix}reconnect* to reconnect.`
                }, { quoted: m })
            }
        }
    }

    await creloadHandler(false)
}

handler.help    = ['reconnect']
handler.tags    = ['session']
handler.command = /^(reconnect)$/i
handler.premium = true
handler.ai      = { risk: "blocked", description: "send reconnect user to sub-bot session" }

export default handler
