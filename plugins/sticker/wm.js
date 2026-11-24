import { quotedAudioOpus, sendAudioSticker } from '../../lib/utils/simple.js'

let handler = async (m, { conn, text }) => {
  if (!m.quoted) throw 'Quoted the sticker!'
  let sent = false
  try {
    let [packname, ...author] = text.split('|')
    author = (author || []).join('|')
    let mime = m.quoted.mimetype || ''
    if (!/webp/.test(mime)) throw 'Reply sticker!'
    let img = await m.quoted.download()
    if (!img) throw 'Reply a sticker!'
    const opus = await quotedAudioOpus(conn, m.quoted).catch(() => null)
    if (opus) await sendAudioSticker(conn, m.chat, img, opus, packname || '', author || '', m)
    else await conn.sendSticker(m.chat, img, { packname: packname || '', author: author || '' }, m)
    sent = true
  } catch (e) {
    console.error(e)
  } finally {
    if (!sent) throw 'Conversion failed'
  }
}
handler.help = ['wm <packname>|<author>']
handler.tags = ['sticker']
handler.command = /^wm$/i

handler.limit = true

handler.platform = { whatsapp: true, discord: false }

export default handler
