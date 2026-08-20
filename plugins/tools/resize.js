import sharp from 'sharp';
import axios from 'axios';
const { fileTypeFromBuffer } = (await import("file-type"));

let handler = async (m, { conn, args, usedPrefix, command }) => {
  var towidth = args[0]
  var toheight = args[1]
  if (!towidth || !toheight) throw `- *Example:* ${usedPrefix + command} <width> <height>`
  var q = m.quoted ? m.quoted : m
  var mime = (q.msg || q).mimetype || ''
  if (!mime) throw "- Please Reply/caption the image you want to resize."
  var media = await q.download()
  var isMedia = /image\/(png|jpe?g)/.test(mime)
  if (!isMedia) throw `- Mime ${mime} not Supported`
  var sourceMeta = await sharp(media).metadata()
  var size = { before:{ height: sourceMeta.height, width: sourceMeta.width },
               after:{ height: toheight, width: towidth } }
  var compres = await conn.resize(media, towidth - 0, toheight - 0)
  conn.sendFile(m.chat, compres, null, `                 *\`Resize Image\`*\n- *Width  :* ${size.before.width} > ${size.after.width}\n- *Height:* ${size.before.height} > ${size.after.height}`, m)
}
handler.help = ['resize [ width ] [ height]']
handler.tags = ['tools']
handler.command = /^(resize)$/i

export default handler
