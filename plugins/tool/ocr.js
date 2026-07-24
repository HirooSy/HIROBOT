import upload from '../../lib/scraper/upload.js'
import ocrapi from "ocr-space-api-wrapper"
let { MessageType } = (await import('baileys')).default

let handler = async (m, { conn, text }) => {
      let q = m.quoted ? m.quoted : m
    let mime = (q.msg || q).mimetype || ''
    if (!mime) throw `balas gambar dengan perintah .ocr`
    if (!/image\/(jpe?g|png)/.test(mime)) throw `_*jenis ${mime} tidak didukung!*_`
    let img = await q.download()
    let url = await upload(img)
    let hasil = await ocrapi.ocrSpace(url)
 await m.reply(hasil.ParsedResults[0].ParsedText)    
}

handler.help = handler.dym = ['ocr', 'totext']
handler.tags = ['tools']
handler.command = /^(ocr|totext)$/i
handler.limit = true

export default handler