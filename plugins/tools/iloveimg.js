
const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


let handler = async (m, { conn, text, args, platform }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ''
  const urlInput = text?.trim().split(/\s+/)[0]

  if (!mime && !(urlInput && urlInput.startsWith('http'))) throw 'Reply/caption an image, or give a direct image URL, to upscale!'
  if (mime && !/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  const words = platform === 'discord' ? String(text || '').trim().split(/\s+/) : args
  let multiplier = parseInt(words[words.length - 1]) || 2
  if (![2, 4].includes(multiplier)) multiplier = 2

  await m.react('⏳')

  try {
    const input = mime ? await q.download() : urlInput

    const result = await global.scraper.iloveimg.upscaleImage(input, multiplier)

    await sendOut(conn, m, {
      image: result.buffer,
      caption: `✅ Upscaled ${result.scale} (${result.sizeMB} MB)`,
      mimetype: 'image/png'
    })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message}`
  }
}

handler.help = [
    ...(['iloveimg', 'ilimg'].map(v => v + ' [2/4]')),
    { command: 'iloveimg', name: 'text', description: 'Image URL and optional multiplier (2 or 4)', type: 'string' },
    { command: 'iloveimg', name: 'file', description: 'Image to upscale (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['iloveimg', 'ilimg']
handler.description = 'Upscale an image with iLoveIMG'
handler.limit = true

handler.platform = { whatsapp: true, discord: true }

export default handler