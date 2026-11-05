const { onlineOcr } = global.scraper.ocr

const defaultLanguage = 'ENGLISH'

let handler = async (ctx, { conn, text, usedPrefix, command, platform }) => {
    const quoted = ctx.quoted ? ctx.quoted : ctx
    const mime = (quoted.msg || quoted).mimetype || ''
    if (!mime.startsWith('image/')) throw `Reply to or caption an image with ${usedPrefix}${command}`

    const language = (text || '').trim() || defaultLanguage
    const buffer = await quoted.download()
    const extension = (mime.split('/')[1] || 'png').split(';')[0]
    const filename = `ocr_${Date.now()}.${extension}`

    const result = await onlineOcr(buffer, filename, language)
    const reply = `${result.text}\n\nSource: ${result.source}`

    if (platform === 'discord') return conn.discord(ctx.chat, { text: reply })
    await conn.sendMessage(ctx.chat, { text: reply }, { quoted: ctx })
}

handler.help = [
    { command: 'ocr', name: 'language', description: 'Language of the text, for example english or indonesian (optional)', type: 'string' },
    { command: 'ocr', name: 'image', description: 'Image to read (reply to one or send one with the command as caption)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['ocr']
handler.description = 'Extract text from an image'
handler.limit = true
handler.ai = { risk: "low", description: "extract text from an image" }

handler.platform = { whatsapp: true, discord: true }

export default handler
