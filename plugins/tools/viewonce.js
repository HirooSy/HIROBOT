let handler = async (m, { conn }) => {
    if (!m.quoted) throw 'where\'s message?'

    const isViewOnce =
    m.quoted.viewOnce === true ||
    m.quoted.msg?.viewOnce === true ||
    m.quoted.message?.imageMessage?.viewOnce === true ||
    m.quoted.message?.videoMessage?.viewOnce === true ||
    m.quoted.message?.audioMessage?.viewOnce === true
    if (!isViewOnce) throw 'That\'s not a viewOnce message'

    const buffer = await m.quoted.download()
    const mtype = m.quoted.mtype
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
        default:
            fileName = 'image.jpg'
    }

    conn.sendFile(m.chat, buffer, fileName, mtype === 'audioMessage' ? '' : caption, m)
}

handler.help = ['readviewonce', 'rvo']
handler.tags = ['tools']
handler.command = /^(readviewonce|rvo)/i
handler.ai = {
    risk: 'low',
    description: 'To read/download viewonce message, and send it to user'
}


export default handler
