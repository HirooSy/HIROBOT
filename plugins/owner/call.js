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

async function collectMedia(m, args, start) {
    const rest = args.slice(start)
    const resolutionArg = rest.find((a) => /^(240p|360p|480p|720p|1080p)$/i.test(a))
    const tempFiles = []
    const media = rest.filter((a) => /^https?:\/\//i.test(a) && !/call\.whatsapp\.com/i.test(a))
    const quotedPath = m.quoted ? await downloadQuotedMedia(m.quoted) : null
    if (quotedPath) {
        tempFiles.push(quotedPath)
        media.unshift(quotedPath)
    }
    return {
        resolution: resolutionArg?.toLowerCase(),
        autoEndCall: rest.some((a) => /^auto$/i.test(a)),
        loop: rest.some((a) => /^loop$/i.test(a)),
        willBeVideo: media.some((src) => VIDEO_EXT_RE.test(src)),
        media: media.length === 0 ? 'silence' : media.length === 1 ? media[0] : media,
        tempFiles
    }
}

function attachGroupCall({ conn, m, voip, call, label, key, tempFiles, kind }) {
    const entry = { call, key, phoneNumber: label, kind }
    addActiveCall(m.chat, entry)
    let waitingCount = 0
    call.on('connected', () => {
        conn.sendMessage(m.chat, { text: `✦ ${label} connected! Use .voipend to leave.`, edit: key })
    })
    call.on('waiting_room', (room) => {
        const users = room?.users ?? []
        if (users.length === waitingCount) return
        waitingCount = users.length
        conn.sendMessage(m.chat, { text: users.length ? `✦ Waiting room (${users.length}): ${users.map((user) => jidNumber(user.jid)).join(', ')}\nUse .voipadmit <number|all> or .voipdeny <number|all>` : '✦ Waiting room is empty.' })
    })
    call.on('downgraded', () => {
        conn.sendMessage(m.chat, { text: '✦ All cameras are off, downgraded to audio.' })
    })
    call.on('ended', (reason) => {
        removeActiveCall(m.chat, entry)
        conn.sendMessage(m.chat, { text: `✦ ${label} ended: ${reason}`, edit: key })
        for (const f of tempFiles) {
            if (fs.existsSync(f)) fs.unlink(f, () => { })
        }
    })
    call.on('error', (err) => {
        if (!voip.calls.includes(call)) removeActiveCall(m.chat, entry)
        conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
    })
    return entry
}

function jidNumber(jid) {
    return `+${String(jid).split('@')[0].split(':')[0]}`
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

    if (command === 'voipinfo') {
        const { call } = requireCall(m)
        const connected = call.participants.filter((participant) => participant.state === 'connected')
        const others = call.participants.filter((participant) => participant.state !== 'connected')
        const waiting = call.waitingRoom?.users ?? []
        return void (await m.reply([
            `✦ Participants in call: ${connected.length}`,
            ...connected.map((participant) => `• ${jidNumber(participant.pn || participant.jid)}${participant.isSelf ? ' (me)' : ''}`),
            ...(others.length ? [`✦ Not connected: ${others.map((participant) => `${jidNumber(participant.pn || participant.jid)} [${participant.state || 'invited'}]`).join(', ')}`] : []),
            ...(waiting.length ? [`✦ Waiting room: ${waiting.map((user) => jidNumber(user.pn || user.jid)).join(', ')}`] : [])
        ].join('\n')))
    }

    if (command === 'voiphand') {
        const { call } = requireCall(m)
        const raised = !/^(off|down|lower)$/i.test(args[0] || '')
        await call.raiseHand(raised)
        return void (await m.reply(raised ? '✦ Hand raised.' : '✦ Hand lowered.'))
    }

    if (command === 'voipapproval') {
        const { call } = requireCall(m)
        if (!/^(on|off)$/i.test(args[0] || '')) throw `Usage: ${usedPrefix + command} <on|off>`
        const enabled = /^on$/i.test(args[0])
        await call.setApprovalRequired(enabled)
        return void (await m.reply(enabled ? '✦ Join approval enabled.' : '✦ Join approval disabled.'))
    }

    if (['voipadd', 'voipring', 'voipadmit', 'voipdeny'].includes(command)) {
        const { call } = requireCall(m)
        const targets = /^all$/i.test(args[0] || '') && ['voipadmit', 'voipdeny'].includes(command)
            ? (call.waitingRoom?.users ?? []).map((user) => user.jid)
            : [...args.filter((a) => /^\+?\d{5,}$/.test(a)).map((a) => a.replace(/\D/g, '')), ...(m.mentionedJid ?? [])]
        if (targets.length === 0) throw `Usage: ${usedPrefix + command} <phone_number${command === 'voipadmit' || command === 'voipdeny' ? '|all' : ''}>`
        const results = await Promise.allSettled(targets.map((target) => call[{ voipadd: 'addParticipant', voipring: 'ringParticipant', voipadmit: 'admit', voipdeny: 'deny' }[command]](target)))
        const failed = results.map((result, index) => result.status === 'rejected' ? `${jidNumber(targets[index])}: ${result.reason?.message || result.reason}` : null).filter(Boolean)
        const done = results.length - failed.length
        return void (await m.reply([`✦ ${command.slice(4)} done for ${done}/${results.length}.`, ...failed].join('\n')))
    }

    if (command === 'voiplink') {
        const entry = requireCall(m)
        if (entry.kind !== 'link') throw 'Get link only works for link calls (.voiproom or .voipjoin).'
        try {
            return void (await m.reply(`✦ Call link:\n${await voip.getLink(entry.call.callId)}`))
        } catch (e) {
            throw e?.message || e
        }
    }

    if (command === 'voiproom') {
        const isVideo = args.some((a) => /^video$/i.test(a))
        const { media, resolution, loop, tempFiles, willBeVideo } = await collectMedia(m, args, 0)
        const { key } = await m.reply(`✦ Creating ${isVideo || willBeVideo ? 'video' : 'voice'} room...`)
        try {
            const call = await voip.createRoom(media, resolution, {
                isVideo: isVideo || willBeVideo,
                requireApproval: args.some((a) => /^approval$/i.test(a)) ? true : args.some((a) => /^open$/i.test(a)) ? false : undefined,
                loop
            })
            attachGroupCall({ conn, m, voip, call, label: 'Room', key, tempFiles, kind: 'link' })
            return void (await m.reply(`✦ Room is live. Share this link:\n${call.link}\n\nUse .voipinfo to list participants, .voipadmit / .voipdeny for the waiting room, .voipend to close.`))
        } catch (e) {
            for (const f of tempFiles) if (fs.existsSync(f)) fs.unlink(f, () => { })
            throw `Failed to create room: ${e?.message || e}`
        }
    }

    if (command === 'voipjoin') {
        if (!args[0]) throw `Usage: ${usedPrefix + command} <call_link> [media_url_or_path ...] [resolution] [loop]`
        const { media, resolution, loop, tempFiles, willBeVideo } = await collectMedia(m, args, 1)
        const { key } = await m.reply(`✦ Joining call link...${willBeVideo ? ' (video)' : ''}`)
        try {
            const call = await voip.joinLink(args[0], media, resolution, { loop, autoEndCall: false })
            attachGroupCall({ conn, m, voip, call, label: 'Call link', key, tempFiles, kind: 'link' })
        } catch (e) {
            for (const f of tempFiles) if (fs.existsSync(f)) fs.unlink(f, () => { })
            throw `Failed to join call link: ${e?.message || e}`
        }
        return
    }

    if (command === 'voipgroup') {
        let targets = [...args.filter((a) => /^\+?\d{5,}$/.test(a)).map((a) => a.replace(/\D/g, '')), ...(m.mentionedJid ?? [])]
        let groupJid
        if (args.some((a) => /^(this|here|chat)$/i.test(a))) {
            if (!m.chat.endsWith('@g.us')) throw 'The "this" option only works inside a group chat.'
            targets = [...targets, ...(await conn.groupMetadata(m.chat)).participants.map((participant) => participant.lid || participant.id)]
            groupJid = m.chat
        }
        targets = [...new Set(targets)].slice(0, 31)
        if (targets.length < 2) throw `Usage: ${usedPrefix + command} <number1> <number2> ... [media_url_or_path ...] [resolution] [loop]\nOr use "${usedPrefix + command} this" inside a group chat to call every member.`
        const { media, resolution, loop, autoEndCall, tempFiles, willBeVideo } = await collectMedia(m, args, 0)
        const { key } = await m.reply(`✦ Starting group call with ${targets.length} participants...${willBeVideo ? ' (video)' : ''}`)
        try {
            const call = await voip.groupCall(targets, media, resolution, { autoEndCall, loop, groupJid })
            attachGroupCall({ conn, m, voip, call, label: 'Group call', key, tempFiles, kind: 'group' })
            call.on('ringing', () => {
                conn.sendMessage(m.chat, { text: `✦ Ringing ${targets.length} participants...`, edit: key })
            })
        } catch (e) {
            for (const f of tempFiles) if (fs.existsSync(f)) fs.unlink(f, () => { })
            throw `Failed to start group call: ${e?.message || e}`
        }
        return
    }

    if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [media_url_or_path ...] [resolution] [auto] [loop] (reply to audio/video, or provide one or more URLs — mixing video and audio URLs plays them as a playlist; add "auto" to hang up automatically once the playlist finishes, "loop" to replay it from the start instead)\nGroup: .voipgroup <n1> <n2> ... | .voiproom [video] [approval|open] | .voiplink (link calls only) | .voipjoin <link>\nDuring a call: .voipsilent .voipreact <emoji> .voiphand .voipinfo .voipadd .voipring .voipadmit .voipdeny .voipapproval <on|off> .voipend`

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

handler.help = ['voipcall <number>', 'voipgroup <numbers>', 'voiproom', 'voiplink', 'voipjoin <link>', 'voipadd <number>', 'voipring <number>', 'voipadmit <number>', 'voipdeny <number>', 'voipapproval <on|off>', 'voiphand', 'voipinfo', 'voipend', 'voipsilent', 'voipreact <emoji>']
handler.tags = ['owner']
handler.command = /^(voipcall|voipgroup|voiproom|voiplink|voipjoin|voipadd|voipring|voipadmit|voipdeny|voipapproval|voiphand|voipinfo|voipend|voipsilent|voipreact)$/i

handler.platform = { whatsapp: { permission: ['owner'] }, discord: false }

export default handler