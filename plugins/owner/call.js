import os from 'os'
import path from 'path'
import fs from 'fs'
import Voip from '../../lib/package/voip/index.js'

const voipInstances = new WeakMap()
function getVoip(conn) {
    let voip = voipInstances.get(conn)
    if (!voip) {
        voip = new Voip(conn)
        voipInstances.set(conn, voip)
    }
    return voip
}

let activeCalls = new Map()

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

let handler = async (m, { conn, args, usedPrefix, command }) => {
    const voip = getVoip(conn)

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

    if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [media_url_or_path ...] [resolution] [auto] [loop] (reply to audio/video, or provide one or more URLs — mixing video and audio URLs plays them as a playlist; add "auto" to hang up automatically once the playlist finishes, "loop" to replay it from the start instead)`
    if (activeCalls.has(m.chat)) throw 'A call is already in progress in this chat, wait for it to finish (or `.voipend`).'

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

    if (media.length === 0) media = 'silence'
    else if (media.length === 1) media = media[0]

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
        const call = await voip.call(phoneNumber, media, resolution, { autoEndCall, loop })
        activeCalls.set(m.chat, { call, key, phoneNumber })

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

handler.help = ['voipcall <number>', 'voipend', 'voipsilent']
handler.tags = ['owner']
handler.command = /^(voipcall|voipend|voipsilent)$/i
handler.rowner = true

export default handler