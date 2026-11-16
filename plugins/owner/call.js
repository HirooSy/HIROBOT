import os from 'os'
import path from 'path'
import fs from 'fs'

async function getVoip(conn) {
    if (!conn.voipInstance) {
        const { default: Voip } = await import('hiro/voip')
        conn.voipInstance ||= new Voip(conn, { voipLogLevel: 'warn' })
    }
    return conn.voipInstance
}

let activeCalls = new Map()

function addActiveCall(chat, entry) {
    if (!activeCalls.has(chat)) activeCalls.set(chat, new Set())
    activeCalls.get(chat).add(entry)
}

function removeActiveCall(chat, entry) {
    const entries = activeCalls.get(chat)
    if (!entries) return
    entries.delete(entry)
    if (entries.size === 0) activeCalls.delete(chat)
}

function chatCalls(chat) {
    return [...(activeCalls.get(chat) ?? [])]
}

const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|#|$)/i

async function downloadQuotedMedia(quoted) {
    const mime = quoted?.mimetype || ''
    const kind = /^video/.test(mime) ? 'video' : /^audio/.test(mime) ? 'audio' : null
    if (!kind) return null

    const buffer = await quoted.download()
    if (!buffer) throw `Failed to download the replied ${kind}.`

    const ext = kind === 'video' ? '.mp4' : '.audio'
    const filePath = path.join(os.tmpdir(), `voip_${kind}_${Date.now()}${ext}`)
    fs.writeFileSync(filePath, buffer)
    return filePath
}

function requireCall(m) {
    const entries = chatCalls(m.chat)
    const entry = entries[entries.length - 1]
    if (!entry) throw 'No call is currently in progress in this chat.'
    return entry
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
    const voip = await getVoip(conn)

    if (command === 'voipend') {
        if (args[0] === 'force') {
            await voip.end(true)
            activeCalls.clear()
            return void (await m.reply('✦ VOIP state force-reset.'))
        }
        const entries = chatCalls(m.chat)
        if (entries.length === 0) throw 'No call is currently in progress in this chat.'
        await Promise.all(entries.map((entry) => entry.call.hangup()))
        for (const entry of entries) removeActiveCall(m.chat, entry)
        return void (await m.reply('✦ Hangup requested...'))
    }

    if (command === 'voipreact') {
        const entry = requireCall(m)
        const emoji = args[0] || '👍'
        const sent = entry.call.react(emoji)
        return void (await m.reply(sent ? `✦ Reaction ${emoji} sent.` : '✦ Failed to send reaction (call is not active yet).'))
    }

    if (command === 'voipsilent') {
        const entry = requireCall(m)
        const nowSilenced = await entry.call.silent()
        return void (await m.reply(nowSilenced ? '✦ Muted mic and paused video.' : '✦ Resumed.'))
    }

    if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [media_url_or_path ...] [resolution] [auto] [loop] (reply to audio/video, or provide one or more URLs — mixing video and audio URLs plays them as a playlist; add "auto" to hang up automatically once the playlist finishes, "loop" to replay it from the start instead)\nDuring a call: .voipsilent .voipreact <emoji> .voipend`

    const phoneNumber = args[0].replace(/\D/g, '')
    if (!phoneNumber) throw 'Invalid phone number.'

    const RESOLUTION_RE = /^(240p|360p|480p|720p|1080p)$/i
    const resolutionArg = args.find((a, i) => i > 0 && RESOLUTION_RE.test(a))
    const resolution = resolutionArg ? resolutionArg.toLowerCase() : undefined

    const autoEndCall = args.some((a, i) => i > 0 && /^auto$/i.test(a))
    const loop = args.some((a, i) => i > 0 && /^loop$/i.test(a))

    const urls = args.filter((a, i) => i > 0 && /^https?:\/\//i.test(a))
    let media = [...urls]
    const tempFiles = []

    const quotedPath = m.quoted ? await downloadQuotedMedia(m.quoted) : null
    if (quotedPath) {
        tempFiles.push(quotedPath)
        media.unshift(quotedPath)
    }

    const willBeVideo = media.some((src) => src !== 'silence' && VIDEO_EXT_RE.test(src))

    if (media.length === 0) media = 'silence'
    else if (media.length === 1) media = media[0]

    const { key } = await m.reply(`✦ Calling ${phoneNumber}...${willBeVideo ? ' (video)' : ''} (Use .voipend to end call, .voipsilent to mute/pause)`)

    const cleanupTempFiles = () => {
        for (const f of tempFiles) {
            if (fs.existsSync(f)) fs.unlink(f, () => { })
        }
    }

    try {
        const call = await voip.call(phoneNumber, media, resolution, { autoEndCall, loop })
        const entry = { call, key, phoneNumber }
        addActiveCall(m.chat, entry)

        call.on('ringing', () => {
            conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
        })
        call.on('connected', () => {
            conn.sendMessage(m.chat, { text: '✦ Call connected! Use .voipend to end.', edit: key })
        })
        call.on('item', ({ index, kind }) => {
            if (index === 0) return
            conn.sendMessage(m.chat, { text: `✦ Now playing item ${index + 1} (${kind}).` })
        })
        call.on('downgraded', () => {
            conn.sendMessage(m.chat, { text: '✦ All cameras are off, downgraded to audio.' })
        })
        call.on('ended', (reason) => {
            removeActiveCall(m.chat, entry)
            const friendlyText = reason === 'declined'
                ? `✦ Call to ${phoneNumber} was declined.`
                : `✦ Call ended for ${phoneNumber}: ${reason}`
            conn.sendMessage(m.chat, { text: friendlyText, edit: key })
            cleanupTempFiles()
        })
        call.on('error', (err) => {
            if (!voip.calls.includes(call)) {
                removeActiveCall(m.chat, entry)
                cleanupTempFiles()
            }
            conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
        })
    } catch (e) {
        console.error('[ VOIP ] voip.call() threw:', e)
        cleanupTempFiles()
        throw `Failed to place call: ${e?.message || e}`
    }
}

handler.help = ['voipcall <number>', 'voipend', 'voipsilent', 'voipreact <emoji>']
handler.tags = ['owner']
handler.command = /^(voipcall|voipend|voipsilent|voipreact)$/i

handler.platform = { whatsapp: { permission: ['owner'] }, discord: false }

export default handler