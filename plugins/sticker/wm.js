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
    await conn.sendSticker(m.chat, img, { packname: packname || '', author: author || '' }, m)
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

export default handler
