
const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


const modes = {
  2: { api_name: 'upscale_x2', label: '×2' },
  4: { api_name: 'standard_upscale', label: '×4' },
  8: { api_name: 'premium_upscale', label: '×8 🚀' }
}

let handler = async (m, { conn, args, platform }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ""
  if (!mime) throw 'Reply/caption an image to upscale!'

  if (!/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  let factor = parseInt(platform === 'discord' ? args.factor : args[0]) || 2
  if (![2, 4, 8].includes(factor)) factor = 2
  const mode = modes[factor]

  await m.react('⏳')

  try {
    const buffer = await q.download()

    const uploadedPath = await global.scraper.hd.uploadToGradio(buffer)

    const resultUrl = await global.scraper.hd.runUpscale(uploadedPath, mode.api_name)

    const res = await global.scraper.hd.downloadResult(resultUrl)

    await sendOut(conn, m, {
      image: Buffer.from(res.data),
      caption: `✅ Upscale ${mode.label}`,
      mimetype: 'image/png'
    })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message}`
  }
}

handler.help = [
    ...(['hd'].map(v => v + " [2/4/8]")),
    { command: 'hd', name: 'factor', description: 'Upscale factor', type: 'integer', choices: [{ name: 'x2', value: 2 }, { name: 'x4', value: 4 }, { name: 'x8', value: 8 }] },
    { command: 'hd', name: 'file', description: 'Image to upscale (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['hd', 'upscale']
handler.description = 'Upscale an image with AI'

handler.platform = { whatsapp: true, discord: true }

export default handler
