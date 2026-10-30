import { jimp } from '../../lib/package/canvas.js';
import axios from '../../lib/package/axios.js';
import Helper from '../../lib/utils/helper.js';
const { fileTypeFromBuffer } = Helper;

let handler = async (m, { conn, args, usedPrefix, command, platform }) => {
  var towidth = platform === 'discord' ? args.width : args[0]
  var toheight = platform === 'discord' ? args.height : args[1]
  if (!towidth || !toheight) throw `- *Example:* ${usedPrefix + command} <width> <height>`
  var q = m.quoted ? m.quoted : m
  var mime = (q.msg || q).mimetype || ''
  if (!mime) throw "- Please Reply/caption the image you want to resize."
  var media = await q.download()
  var isMedia = /image\/(png|jpe?g)/.test(mime)
  if (!isMedia) throw `- Mime ${mime} not Supported`
  var sourceMeta = jimp.metadata(media)
  var size = { before:{ height: sourceMeta.height, width: sourceMeta.width },
               after:{ height: toheight, width: towidth } }
  var caption = `                 *\`Resize Image\`*\n- *Width  :* ${size.before.width} > ${size.after.width}\n- *Height:* ${size.before.height} > ${size.after.height}`
  if (platform === 'discord') {
    var resized = await jimp.resize(media, towidth - 0, toheight - 0, { fit: 'cover' })
    return conn.discord(m.chat, { image: resized, fileName: 'resized.png', text: caption.replace(/\*([^*\n]+)\*/g, '**$1**') })
  }
  var compres = await conn.resize(media, towidth - 0, toheight - 0)
  conn.sendFile(m.chat, compres, null, caption, m)
}
handler.help = [
    ...(['resize [ width ] [ height]']),
    { command: 'resize', name: 'width', description: 'New width in pixels', type: 'integer', required: true, min_value: 1, max_value: 8000 },
    { command: 'resize', name: 'height', description: 'New height in pixels', type: 'integer', required: true, min_value: 1, max_value: 8000 },
    { command: 'resize', name: 'file', description: 'Image to resize (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['resize']
handler.description = 'Resize an image'

handler.platform = { whatsapp: true, discord: true }

export default handler
