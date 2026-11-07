const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

let handler = async (m, { conn, text }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ''
  const urlInput = text?.trim()

  if (!mime && !urlInput) throw 'Reply/caption an image, or give a direct image URL, to enhance!'
  if (mime && !/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  await m.react('⏳')

  try {
    const input = mime ? await q.download() : urlInput

    const result = await global.scraper.wink.enhance(input)

    const res = await global.scraper.wink.downloadResult(result.url)

    await sendOut(conn, m, {
      image: Buffer.from(res.data),
      caption: `✅ Enhanced${result.width && result.height ? ` (${result.width}x${result.height})` : ''}`,
      mimetype: 'image/png'
    })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message}`
  }
}

handler.help = [
    ...(['wink'].map(v => v + ' (Reply/Url Image)')),
    { command: 'wink', name: 'text', description: 'Image URL', type: 'string' },
    { command: 'wink', name: 'file', description: 'Image to enhance (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['wink']
handler.description = 'Enhance an image with AI'
handler.limit = true

handler.platform = { whatsapp: true, discord: true }

export default handler
