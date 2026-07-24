import axios from 'axios';
import * as cheerio from 'cheerio';

let handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) return m.reply(`Masukkan URL Reddit!\n\nContoh:\n${usedPrefix + command} https://www.reddit.com/r/...`)

  if (!/reddit\.com|redd\.it/i.test(text)) return m.reply(`Invalid Reddit Url!`)

  await m.react('⬇️')

  try {
    const data = await scrapeRapidSave(text)

    if (!data || !data.download) {
      return m.reply('Gagal ambil data. Link mungkin private atau salah.')
    }

    if (data.type === 'image') {
      const img = await axios.get(data.download.image, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })

      return conn.sendMessage(
        m.chat,
        {
          image: img.data,
          caption: `*REDDIT IMAGE*\n${data.title || ''}`
        },
        { quoted: m }
      )
    }

    if (data.type === 'video') {
      const vid = await axios.get(data.download.video, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })

      await conn.sendMessage(
        m.chat,
        {
          video: vid.data,
          caption: `*REDDIT VIDEO*\n${data.title || ''}`
        },
        { quoted: m }
      )

      if (data.download.audio) {
        const aud = await axios.get(data.download.audio, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })

        await conn.sendMessage(
          m.chat,
          {
            audio: aud.data,
            mimetype: 'audio/mp4',
            fileName: 'audio.mp4'
          },
          { quoted: m }
        )
      }

      return
    }
  } catch (e) {
    console.error(e)
    return m.reply('Error: ' + (e.message || 'Unknown error'))
  }
}

handler.help = ['reddit', 'redditdl']
handler.command = /^(reddit|redditdl)$/i
handler.tags = ['downloader']
handler.limit = true

export default handler

async function scrapeRapidSave(redditUrl) {
  // Convert redd.it shortlink to full URL
  if (redditUrl.includes('redd.it')) {
    const res = await axios.head(redditUrl, { maxRedirects: 0, validateStatus: s => s >= 300 && s < 400 })
    redditUrl = res.headers.location || redditUrl
  }

  const url = `https://rapidsave.com/info?url=${encodeURIComponent(redditUrl)}`

  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://rapidsave.com/'
    },
    timeout: 20000
  })

  const $ = cheerio.load(html)

  const title = $('h2.text-center, h2[class*="title"]').first().text().trim()

  const imageDownload = $('a.downloadbutton')
    .filter((i, el) => !$(el).attr('href').includes('video_url'))
    .attr('href')

  const videoHD = $('a.downloadbutton[href*="video_url"]').attr('href') || null

  const audioHref = $('a[href^="/d/"]').first().attr('href')
  const audioOnly = audioHref ? 'https://rapidsave.com' + audioHref : null

  if (!imageDownload && !videoHD) {
    throw new Error('No download link found. Post might be removed or private.')
  }

  return {
    type: videoHD ? 'video' : 'image',
    title,
    download: videoHD
      ? { video: videoHD, audio: audioOnly }
      : { image: imageDownload }
  }
}