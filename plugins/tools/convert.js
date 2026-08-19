const { webp2png, webp2mp4 } = global.scraper.ezgif
import { ffmpeg, toPTT, toAudio } from '../../lib/utils/converter.js'

let handler = async (m, { conn, usedPrefix, command }) => {

    if (command == "toimg") {
        const notStickerMessage = `Reply sticker with command *${usedPrefix + command}*`
        if (!m.quoted) throw notStickerMessage
        const q = m.quoted || m
        let mime = q.mediaType || ''
        if (!/sticker/.test(mime)) throw notStickerMessage
        let media = await q.download()
        let url = await webp2png(media).catch(_ => null)
        if (!url) throw 'Gagal mengonversi stiker ke gambar'
        let out = Buffer.from(await (await fetch(url)).arrayBuffer())
        await conn.sendFile(m.chat, out, 'out.png', null, m)
    }

    if (command == "tovideo") {
        if (!m.quoted) throw `Balas stiker/audio yang ingin diubah menjadi video dengan perintah ${usedPrefix + command}`
        let mime = m.quoted.mimetype || ''
        if (!/webp|audio/.test(mime)) throw `Balas stiker/audio yang ingin diubah menjadi video dengan perintah ${usedPrefix + command}`
        let media = await m.quoted.download()
        let out = Buffer.alloc(0)
        if (/webp/.test(mime)) {
            let url = await webp2mp4(media).catch(_ => null)
            if (!url) throw 'Gagal mengonversi stiker ke video'
            out = Buffer.from(await (await fetch(url)).arrayBuffer())
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

    if (/^to(vn|ptt|voicenote)$/i.test(command)) {
        let q = m.quoted ? m.quoted : m
        let mime = (m.quoted ? m.quoted : m.msg).mimetype || ''
        if (!/video|audio/.test(mime)) throw `reply video/audio you want to convert to voice note/vn with caption *${usedPrefix + command}*`
        let media = await q.download?.()
        if (!media) throw 'Can\'t download media'
        let audio = await toPTT(media, 'mp4')
        if (!audio.data) throw 'Can\'t convert media to audio'
        conn.sendFile(m.chat, audio.data, 'audio.mp3', '', m, true, { mimetype: 'audio/mp4' })
    }

    if (/^to(mp3|a(udio)?)$/i.test(command)) {
        let q = m.quoted ? m.quoted : m
        let mime = (m.quoted ? m.quoted : m.msg).mimetype || ''
        if (!/video|audio/.test(mime)) throw `reply video/voice note you want to convert to audio/mp3 with caption *${usedPrefix + command}*`
        let media = await q.download?.()
        if (!media) throw 'Can\'t download media'
        let audio = await toAudio(media, 'mp4')
        if (!audio.data) throw 'Can\'t convert media to audio'
        conn.sendFile(m.chat, audio.data, 'audio.mp3', '', m, null, { mimetype: 'audio/mp4' })
    }
}

handler.tags = ['tools']
handler.help = ["toimg", "tovideo", "tovn", "tovoicenote", "tomp3"]
handler.command = /^(toimg|tovideo|to(vn|ptt|voicenote)|to(mp3|a(udio)?))$/i
handler.ai = { risk: "low", description: "convert sticker to image/video, convert video to audio/mp3, convert audio/video to voice note" }

export default handler
