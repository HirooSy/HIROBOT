import { webp2png, webp2mp4 } from '../../lib/scraper/ezgif.js'
import { ffmpeg } from '../../lib/tools/converter.js'

let handler = async (m, { conn, usedPrefix, command }) => {
	
	if (command == "toimg") {
    const notStickerMessage = `Reply sticker with command *${usedPrefix + command}*`
    if (!m.quoted) throw notStickerMessage
    const q = m.quoted || m
    let mime = q.mediaType || ''
    if (!/sticker/.test(mime)) throw notStickerMessage
    let media = await q.download()
    let out = await webp2png(media).catch(_ => null) || Buffer.alloc(0)
    await conn.sendFile(m.chat, out, 'out.png', null, m)
    }
    
    if (command == "tovideo") {
    if (!m.quoted) throw `Balas stiker/audio yang ingin diubah menjadi video dengan perintah ${usedPrefix + command}`
    let mime = m.quoted.mimetype || ''
    if (!/webp|audio/.test(mime)) throw `Balas stiker/audio yang ingin diubah menjadi video dengan perintah ${usedPrefix + command}`
    let media = await m.quoted.download()
    let out = Buffer.alloc(0)
    if (/webp/.test(mime)) {
        out = await webp2mp4(media)
    } else if (/audio/.test(mime)) {
        out = await ffmpeg(media, [
            '-filter_complex', 'color',
            '-pix_fmt', 'yuv420p',
            '-crf', '51',
            '-c:a', 'copy',
            '-shortest'
        ], 'mp3', 'mp4')
    }
    await conn.sendFile(m.chat, out, 'out.mp4', null, m)
    }
}
handler.tags = ['sticker']
handler.command = handler.help = handler.dym = ["toimg", "tovideo"]

export default handler