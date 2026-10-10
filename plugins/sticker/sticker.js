const upload = global.scraper.upload.default
const { webp2png } = global.scraper.ezgif

let handler = async (m, { conn, args, usedPrefix, command }) => {
  let user = db.data.users[m.sender]
  let wmSticker = global.settings.sticker_wm

  let customName = null
  let customAuthor = null

  if (args[0] && args[0].includes('|')) {
    const parts = args.join(' ').split('|')
    customName = parts[0]?.trim() || null
    customAuthor = parts[1]?.trim() || null
  } else if (args[0] && !isUrl(args[0]) && !args[0].startsWith('http')) {
    customName = args.join(' ').trim()
  }

  let scap = {
    name: customName !== null ? customName : (user.level == 1 ? '' : user.level >= 2 ? user.sname : wmSticker[0]),
    author: customAuthor !== null ? customAuthor : (user.level == 1 ? '' : user.level >= 2 ? user.sauth : wmSticker[1]),
  }

  let sent = false
  try {
    let q = m.quoted ? m.quoted : m
    let mime = (q.msg || q).mimetype || q.mediaType || ''

    let urlArg = args.find(arg => isUrl(arg))

    if (q.mtype === 'albumMessage') {
      const medias = (await q.downloadAlbum()).filter(v => {
        if (!Buffer.isBuffer(v.buffer) || !v.buffer.length) return false
        if (v.type === 'video' && (v.message.message.videoMessage?.seconds || 0) > 10) return false
        return true
      })
      if (!medias.length) {
        sent = true
        return m.reply('> Album is empty or media has expired')
      }
      const maxPerPack = 60
      const totalPacks = Math.ceil(medias.length / maxPerPack)
      for (let i = 0; i < totalPacks; i++) {
        const chunk = medias.slice(i * maxPerPack, (i + 1) * maxPerPack)
        const baseName = scap.name || 'Sticker Pack'
        await conn.sendStickerPack(m.chat, {
          cover: chunk[0].buffer,
          stickers: chunk.map(v => ({ data: v.buffer })),
          name: totalPacks > 1 ? `${baseName} (${i + 1}/${totalPacks})` : baseName,
          publisher: scap.author || '',
          description: ''
        }, m)
        sent = true
        if (i < totalPacks - 1) await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } else if (/webp|image|video/g.test(mime)) {
      if (/video/g.test(mime)) if ((q.msg || q).seconds > 11) return m.reply('Maksimal 10 detik!')
      let img = await q.download?.()
      if (!img) throw `> Reply or caption image/video/stiker`
      try {
        await conn.sendSticker(m.chat, img, { packname: scap.name, author: scap.author }, m)
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
        await conn.sendSticker(m.chat, false, { packname: scap.name, author: scap.author, url: out }, m)
        sent = true
      }
    } else if (urlArg) {
      const response = await fetch(urlArg)
      const buffer = await response.buffer()
      const out = await upload(buffer)
      await conn.sendSticker(m.chat, false, { packname: scap.name, author: scap.author, url: out }, m)
      sent = true
    } else if (args[0] && !args[0].includes('|')) {
      return m.reply('> URL tidak valid!')
    }
  } catch (e) {
    console.error(e)
  } finally {
    if (!sent) throw '> !  Conversion failed'
  }
}

handler.help = ['sticker', 's'].map(v => v + ` (caption|reply media|reply album|url) [name|author]`)
handler.tags = ['sticker']
handler.command = /^s(tic?ker)?(gif)?(wm)?$/i

handler.limit = true
export default handler

const isUrl = (text) => {
  return text.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)(jpe?g|gif|png)/, 'gi'))
}