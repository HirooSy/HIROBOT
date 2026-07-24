import { sticker } from '../../lib/tools/sticker.js'
import upload from '../../lib/scraper/upload.js'
import { webp2png } from '../../lib/scraper/ezgif.js'
import fetch from 'node-fetch'
const { default: { Image }} = await import('node-webpmux')

let handler = async (m, { conn, args, text, usedPrefix, command }) => {
  let user = db.data.users[m.sender]
  let [packname, ...author] = text.split('|')
  author = (author || []).join('|')
  let scap = {
              name: packname || '', 
              author: author || '',
              }
  
  let stiker = false
  try {
    let q = m.quoted ? m.quoted : m
    let mime = (q.msg || q).mimetype || q.mediaType || ''
    if (/webp|image|video/g.test(mime)) {
      if (/video/g.test(mime)) if ((q.msg || q).seconds > 11) return m.reply('Maksimal 10 detik!')
      let img = await q.download?.()
      if (!img) throw `> Reply or caption image/video/stiker`
      let out
      try {
        stiker = await addExif(await sticker(img, false, false, false), scap.name, scap.author)
      } catch (e) {
        console.error(e)
      } finally {
        if (!stiker) {
          if (/webp/g.test(mime)) out = await webp2png(img)
          else if (/video|image/g.test(mime)) out = await upload(img)
          if (!out || typeof out !== 'string') {
            // fallback jika upload gagal
            const uploadFile = (await import('../../lib/scraper/upload.js')).default
            out = await uploadFile(img)
          }
          stiker = await addExif(await sticker(false, out, false, false), scap.name, scap.author)
        }
      }
    } else if (args[0]) {
      if (isUrl(args[0])) {
        const response = await fetch(args[0])
        const buffer = await response.buffer()
        const out = await upload(buffer)
        stiker = await addExif(await sticker(false, out, false, false), scap.name, scap.author)
      } else return m.reply('URL tidak valid!')
    }
  } catch (e) {
    console.error(e)
    if (!stiker) stiker = e
  } finally {
    if (stiker) conn.sendFile(m.chat, stiker, 'sticker.webp', '', m)
    else throw '> !  Conversion failed'
  }
}
handler.help = ['smeta (caption|reply media)', 'smeta <url>']
handler.tags = ['sticker']
handler.dym = ["smeta"]
handler.command = /^smeta$/i

handler.limit = true
export default handler

const isUrl = (text) => {
  return text.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)(jpe?g|gif|png)/, 'gi'))
}

async function addExif(buffer, packname, author, categories = [''], extra = {}) {
	const img = new Image()
	const json = { 'sticker-pack-id': process.env.BOT_NAME, 'sticker-pack-name': packname, 'sticker-pack-publisher': author, 'emojis': categories, 'is-avatar-sticker': 1, ...extra }
	let exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
	let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8')
	let exif = Buffer.concat([exifAttr, jsonBuffer])
	exif.writeUIntLE(jsonBuffer.length, 14, 4)
	await img.load(buffer)
	img.exif = exif
	return await img.save(null)
}