const upload = global.scraper.upload.default
const { webp2png } = global.scraper.ezgif

let handler = async (m, { conn, args, text, usedPrefix, command }) => {
  let [packname, ...author] = text.split('|')
  author = (author || []).join('|')
  let scap = {
              name: packname || '',
              author: author || '',
              }

  let sent = false
  try {
    let q = m.quoted ? m.quoted : m
    let mime = (q.msg || q).mimetype || q.mediaType || ''
    if (/webp|image|video/g.test(mime)) {
      if (/video/g.test(mime)) if ((q.msg || q).seconds > 11) return m.reply('Maksimal 10 detik!')
      let img = await q.download?.()
      if (!img) throw `> Reply or caption image/video/stiker`
      try {
        await conn.sendSticker(m.chat, img, { packname: scap.name, author: scap.author, extra: { 'is-ai-sticker': 1 } }, m)
        sent = true
      } catch (e) {
        console.error(e)
      }
      if (!sent) {
        let out
        if (/webp/g.test(mime)) out = await webp2png(img)
        else if (/video|image/g.test(mime)) out = await upload(img)
        if (!out || typeof out !== 'string') {
          out = await global.scraper.upload.default(img)
        }
        await conn.sendSticker(m.chat, false, { packname: scap.name, author: scap.author, url: out, extra: { 'is-ai-sticker': 1 } }, m)
        sent = true
      }
    } else if (args[0]) {
      if (isUrl(args[0])) {
        const response = await fetch(args[0])
        const buffer = await response.buffer()
        const out = await upload(buffer)
        await conn.sendSticker(m.chat, false, { packname: scap.name, author: scap.author, url: out, extra: { 'is-ai-sticker': 1 } }, m)
        sent = true
      } else return m.reply('URL tidak valid!')
    }
  } catch (e) {
    console.error(e)
  } finally {
    if (!sent) throw '> !  Conversion failed'
  }
}
handler.help = ['smeta (caption|reply media)', 'smeta <url>']
handler.tags = ['sticker']
handler.command = /^smeta$/i

handler.limit = true
export default handler

const isUrl = (text) => {
  return text.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)(jpe?g|gif|png)/, 'gi'))
}
