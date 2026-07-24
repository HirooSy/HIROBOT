let handler = async (m, { conn }) => {
    if (!m.quoted) throw 'where\'s message?'

    // Cek viewOnce: support format lama & baru
    const isViewOnce =
    m.quoted.viewOnce === true ||
    m.quoted.msg?.viewOnce === true ||
    m.quoted.message?.imageMessage?.viewOnce === true ||
    m.quoted.message?.videoMessage?.viewOnce === true ||
    m.quoted.message?.audioMessage?.viewOnce === true
    if (!isViewOnce) throw 'That\'s not a viewOnce message'

    const buffer = await m.quoted.download()
    const mtype = m.quoted.mtype  // 'imageMessage' | 'videoMessage' | 'audioMessage'
    const media = m.quoted.mediaMessage?.[m.quoted.mediaType] || {}
    const caption = media.caption || ''

    let fileName
    switch (mtype) {
        case 'videoMessage':
            fileName = 'video.mp4'
            break
        case 'audioMessage':
            fileName = 'audio.ogg'
            break
        default: // imageMessage
            fileName = 'image.jpg'
    }

    conn.sendFile(m.chat, buffer, fileName, mtype === 'audioMessage' ? '' : caption, m)
}

handler.help = ['readviewonce', 'rvo']
handler.tags = ['tools']
handler.command = /^(readviewonce|rvo)/i

export default handler