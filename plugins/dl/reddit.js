import * as fs from 'fs';

const { gifToMp4, fixVideoMetadata } = global.scraper.x;

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

let handler = async (m, { conn, text }) => {
  if (!text) return m.reply(`Where's the URL?`)
  if (!/reddit\.com|redd\.it/i.test(text)) return m.reply(`Invalid Reddit Url!`)

  await m.react('⬇️')

  try {
    const data = await global.scraper.reddit.scrapeRapidSave(text.trim())

    if (!data || !data.download) {
      return m.reply('Failed to fetch data. Link may be private or incorrect.')
    }

    if (data.type === 'image') {
      return sendOut(conn, m, {
        image: await global.scraper.reddit.downloadMedia(data.download.image),
        caption: data.title || ''
      })
    }

    if (data.type === 'gif') {
      const tmpPath = await gifToMp4(data.download.gif)
      try {
        return await sendOut(conn, m, {
          video: fs.readFileSync(tmpPath),
          gifPlayback: true,
          caption: data.title || ''
        })
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      }
    }

    if (data.type === 'video') {
      const tmpPath = await fixVideoMetadata(data.download.video)
      try {
        await sendOut(conn, m, {
          video: fs.readFileSync(tmpPath),
          caption: data.title || ''
        })
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      }

      if (data.download.audio) {
        await sendOut(conn, m, {
          audio: await global.scraper.reddit.downloadMedia(data.download.audio),
          mimetype: 'audio/mp4',
          fileName: 'audio.mp4'
        })
      }
    }
  } catch (e) {
    return m.reply('Error: ' + (e.message || 'Unknown error'))
  }
}

handler.help = [
    ...(['reddit', 'redditdl']),
    { command: 'reddit', name: 'text', description: 'Reddit post URL', type: 'string', required: true }
]
handler.command = ['reddit', 'redditdl']
handler.description = 'Download media from a Reddit post'
handler.tags = ['downloader']
handler.limit = true
handler.ai = { risk: 'low', description: 'download reddit post' }

handler.platform = { whatsapp: true, discord: true }

export default handler
