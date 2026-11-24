const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage']

const unwrapMessage = message => {
    const inner = message?.viewOnceMessage || message?.viewOnceMessageV2 || message?.viewOnceMessageV2Extension || message?.ephemeralMessage
    return inner?.message ? unwrapMessage(inner.message) : message
}

const getMedia = message => {
    const content = unwrapMessage(message)
    const type = Object.keys(content || {}).find(key => MEDIA_TYPES.includes(key))
    return type ? { type, media: content[type] } : null
}

const hasMediaContent = message => {
    const found = getMedia(message)
    return !!(found?.media?.url || found?.media?.directPath)
}

const waitForFullMessage = (conn, id, timeout = 30000) => new Promise((resolve, reject) => {
    const onUpsert = ({ messages = [] }) => {
        const found = messages.find(msg => msg.key?.id === id && hasMediaContent(msg.message))
        if (!found) return
        clearTimeout(timer)
        conn.ev.off('messages.upsert', onUpsert)
        resolve(found)
    }
    const timer = setTimeout(() => {
        conn.ev.off('messages.upsert', onUpsert)
        reject(new Error('timeout'))
    }, timeout)
    conn.ev.on('messages.upsert', onUpsert)
})

let handler = async (m, { conn }) => {
    if (!m.quoted) throw 'where\'s message?'

    const isViewOnce =
    m.quoted.viewOnce === true ||
    m.quoted.msg?.viewOnce === true ||
    m.quoted.message?.imageMessage?.viewOnce === true ||
    m.quoted.message?.videoMessage?.viewOnce === true ||
    m.quoted.message?.audioMessage?.viewOnce === true
    if (!isViewOnce) throw 'That\'s not a viewOnce message'

    const contextInfo = m.msg?.contextInfo || {}
    const id = contextInfo.stanzaId || m.quoted.id
    const key = {
        remoteJid: m.chat,
        fromMe: m.quoted.fromMe,
        id,
        ...(m.isGroup ? { participant: contextInfo.participant } : {})
    }

    let full = [conn.loadMessage?.(m.chat, id), conn.loadMessage?.(id)].find(msg => hasMediaContent(msg?.message))
    if (!full) {
        const pending = waitForFullMessage(conn, id)
        pending.catch(() => {})
        try {
            await conn.requestPlaceholderResend(key)
            full = await pending
        } catch {
            throw 'Could not get the view once content from your phone, try again later.'
        }
    }

    const { type: mtype, media } = getMedia(full.message)
    const buffer = await conn.downloadM(media, mtype.replace(/message/i, ''), {})
    if (!buffer?.length) throw 'View once content is empty, try again later.'

    const caption = media.caption || ''

    let fileName
    switch (mtype) {
        case 'videoMessage':
            fileName = 'video.mp4'
            break
        case 'audioMessage':
            fileName = 'audio.ogg'
            break
        default:
            fileName = 'image.jpg'
    }

    await conn.sendFile(m.chat, buffer, fileName, mtype === 'audioMessage' ? '' : caption, m)
}

handler.help = ['readviewonce', 'rvo']
handler.tags = ['tools']
handler.command = /^(readviewonce|rvo)/i
handler.ai = {
    risk: 'low',
    description: 'To read/download viewonce message, and send it to user'
}

handler.platform = { whatsapp: true, discord: false }

export default handler