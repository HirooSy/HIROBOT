
const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

let handler = async (m, { conn, text, args, usedPrefix, command, platform }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ''
  const rawArg = (text || '').trim().split(/\s+/)[0] || ''
  const isUrlArg = rawArg.startsWith('http')
  const modeArg = (platform === 'discord' ? String(text || '').trim().split(/\s+/) : args).find(a => global.scraper.removebg.validModes.includes(a.toLowerCase()))?.toLowerCase()

  if (!mime && !isUrlArg) {
    return m.reply(`Reply/caption an image, or give a direct image URL, to remove its background.\n\n- ${usedPrefix + command} (reply to an image)\n- ${usedPrefix + command} <image_url>\n- ${usedPrefix + command} <mode> (reply to an image)\n\nModes: ${global.scraper.removebg.validModes.join(', ')}`)
  }
  if (mime && !/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  await m.react('⏳')

  try {
    const ezInput = mime
      ? { imageBuffer: await q.download(), mode: modeArg }
      : { imageUrl: rawArg, mode: modeArg }

    const result = await global.scraper.removebg.ezRemove(ezInput)

    if (!result.Status) {
      await m.react('❌')
      throw result.Error
    }

    const outUrl = result.Result.maxQuality || result.Result.preview
    if (!outUrl) {
      await m.react('❌')
      throw 'The server did not return a result URL.'
    }

    const res = await global.scraper.removebg.downloadResult(outUrl)

    await sendOut(conn, m, {
      image: Buffer.from(res.data),
      caption: `✅ Background removed (${result.Result.mode})`,
      mimetype: 'image/png'
    })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message || error}`
  }
}

handler.help = [
    ...(['removebg']),
    { command: 'removebg', name: 'text', description: 'Image URL, or a mode like anime, logo or text', type: 'string' },
    { command: 'removebg', name: 'file', description: 'Image to process (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['removebg']
handler.description = 'Remove the background of an image'
handler.limit = true

handler.platform = { whatsapp: true, discord: true }

export default handler
