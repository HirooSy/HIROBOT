import path from 'path'
import fs from 'fs'
import Voip from '../../lib/package/voip/index.js'

// One Voip instance per conn — it already guards against a second
// concurrent call ("A call is already in progress"), so this map just
// avoids re-wrapping the same conn on every command.
const voipInstances = new WeakMap()
function getVoip(conn) {
    let voip = voipInstances.get(conn)
    if (!voip) {
        voip = new Voip(conn)
        voipInstances.set(conn, voip)
    }
    return voip
}

let activeCalls = new Map() // chatId -> { call, key, phoneNumber }

let handler = async (m, { conn, args, usedPrefix, command }) => {
    const voip = getVoip(conn)

    if (command === 'voippair') {
        // VOIP runs on the bot's own main session now - there's no separate
        // device/file to pair or clear. Kept as a harmless no-op (rather
        // than removed outright) so existing muscle memory/scripts calling
        // `.voippair` don't start erroring.
        return void (await m.reply('✦ VOIP uses the bot\'s main session directly - no pairing needed. You can use .voipcall directly.'))
    }

    if (command === 'voipend') {
        await voip.end(args[0] === 'force')
        activeCalls.delete(m.chat)
        return void (await m.reply(args[0] === 'force' ? '✦ VOIP state force-reset.' : '✦ Hangup requested...'))
    }

    if (command === 'voipsilent') {
        const entry = activeCalls.get(m.chat)
        if (!entry) throw 'No call is currently in progress in this chat.'
        const nowSilenced = await entry.call.silent()
        return void (await m.reply(nowSilenced ? '✦ Muted mic and paused video.' : '✦ Resumed.'))
    }

    // .voipcall <number> [media ...] [video] [720p/480p/etc] [auto]
    if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [media_url_or_path ...] [resolution] [auto] (reply to audio/video, or provide one or more URLs — mixing video and audio URLs plays them as a playlist; add "auto" to hang up automatically once the playlist finishes)`
    if (activeCalls.has(m.chat)) throw 'A call is already in progress in this chat, wait for it to finish (or `.voipend`).'

    const phoneNumber = args[0].replace(/\D/g, '')
    if (!phoneNumber) throw 'Invalid phone number.'

    const RESOLUTION_RE = /^(240p|360p|480p|720p|1080p)$/i
    const resolutionArg = args.find((a, i) => i > 0 && RESOLUTION_RE.test(a))
    const resolution = resolutionArg ? resolutionArg.toLowerCase() : undefined

    const autoEndCall = args.some((a, i) => i > 0 && /^auto$/i.test(a))

    const urls = args.filter((a, i) => i > 0 && /^https?:\/\//i.test(a))
    let media = [...urls]
    let tempFiles = []

    if (m.quoted) {
        const mime = m.quoted.mimetype || ''
        const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp')
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
        if (/^video/.test(mime)) {
            const buffer = await m.quoted?.download()
            if (!buffer) throw 'Failed to download the replied video.'
            const videoPath = path.join(tmpDir, `voipvideo_${Date.now()}.mp4`)
            fs.writeFileSync(videoPath, buffer)
            tempFiles.push(videoPath)
            media.unshift(videoPath)
        } else if (/^audio/.test(mime)) {
            const buffer = await m.quoted?.download()
            if (!buffer) throw 'Failed to download the replied audio.'
            const audioPath = path.join(tmpDir, `voip_${Date.now()}.audio`)
            fs.writeFileSync(audioPath, buffer)
            tempFiles.push(audioPath)
            media.unshift(audioPath)
        }
    }

    if (media.length === 0) media = 'silence'
    else if (media.length === 1) media = media[0]
    // else: leave as an array — Voip plays it as a playlist, auto-detecting
    // video vs audio per item from its extension and upgrading/downgrading
    // mid-call between them as needed.

    const willBeVideo = (Array.isArray(media) ? media : [media]).some((src) =>
        src !== 'silence' && /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|#|$)/i.test(src)
    )

    const { key } = await m.reply(`✦ Calling ${phoneNumber}...${willBeVideo ? ' (video)' : ''} (Use .voipend to end call, .voipsilent to mute/pause)`)

    const cleanupTempFiles = () => {
        for (const f of tempFiles) {
            if (fs.existsSync(f)) fs.unlink(f, () => { })
        }
    }

    try {
        const call = await voip.call(phoneNumber, media, resolution, { autoEndCall })
        activeCalls.set(m.chat, { call, key, phoneNumber })

        call.on('ringing', () => {
            conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
        })
        call.on('connected', () => {
            conn.sendMessage(m.chat, { text: '✦ Call connected! Use .voipend to end.', edit: key })
        })
        call.on('item', ({ index, kind }) => {
            if (index === 0) return // first item is already announced above
            conn.sendMessage(m.chat, { text: `✦ Now playing item ${index + 1} (${kind}).` })
        })
        call.on('ended', (reason) => {
            activeCalls.delete(m.chat)
            const friendlyText = reason === 'declined'
                ? `✦ Call to ${phoneNumber} was declined.`
                : `✦ Call ended for ${phoneNumber}: ${reason}`
            conn.sendMessage(m.chat, { text: friendlyText, edit: key })
            cleanupTempFiles()
        })
        call.on('error', (err) => {
            activeCalls.delete(m.chat)
            conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
            cleanupTempFiles()
        })
    } catch (e) {
        console.error('[ VOIP ] voip.call() threw:', e)
        activeCalls.delete(m.chat)
        cleanupTempFiles()
        throw `Failed to place call: ${e?.message || e}`
    }
}

handler.help = ['voippair', 'voipcall <number> [media ...] [resolution] [auto]', 'voipend', 'voipsilent']
handler.tags = ['owner']
handler.command = /^(voippair|voipcall|voipend|voipsilent)$/i
handler.rowner = true

export default handler
