import axios from 'axios'
import fs from 'fs'
const upload = global.scraper.upload.default
const {
  pinterest,
  gifToMp4,
  getPinterestHLS,
  formatNumber,
  mergeVideoAudio,
  isPinterestUrl,
  detectMode,
  extractMediaFromPin
} = global.scraper.pinterest

// ─── Main Handler ────────────────────────────────────────────────────────────
let handler = async (m, { conn, args }) => {
  if (!args[0]) throw `Usage:\n\n*Download by URL:*\n.pin https://pinterest.com/pin/xxx\n.pin https://pin.it/xxx\n\n*Search:*\n.pin <keyword>\n.pin video <keyword>\n.pin image <keyword>\n.pin gif <keyword>`

  const firstArg = args[0]

  // ─── MODE: Download by URL ───────────────────────────────────────────────
  if (isPinterestUrl(firstArg)) {
    await m.reply('Fetching pin info...')

    const downloadResult = await pinterest.download(firstArg)
    if (!downloadResult.status) {
      throw downloadResult.result.message
    }

    const result = downloadResult.result
    const media = result.media_urls[0]
    const title = result.title || ""
    const desc = result.description || ""
    const creator = result.uploader.full_name || result.uploader.username || ""
    const saves = formatNumber(result.statistics.saves || 0)

    const infoText = `Pinterest Pin\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}`

    if (media.type === 'gif' || media.url?.toLowerCase().includes('.gif')) {
      try {
        const videoPath = await gifToMp4(media.url)
        await conn.sendFile(m.chat, fs.readFileSync(videoPath), 'converted.mp4', infoText, m)
        fs.unlinkSync(videoPath)
        return
      } catch (error) {
        throw `Failed to convert GIF to video: ${error.message}`
      }
    }

    if (media.type === 'image') {
      await conn.sendFile(m.chat, media.url, 'pinterest.jpg', infoText, m)
      return
    }

    if (media.type === 'video') {
      const hls = await getPinterestHLS(media.url)
      if (!hls || !hls.qualities.length) throw 'Failed to get video quality.'

      const qualityList = hls.qualities.map((q, i) => `${i + 1}. ${q.resolution}`).join('\n')
      const caption = `Pinterest Video\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}\n\nChoose Resolution:\n${qualityList}`

      const sent = await conn.reply(m.chat, caption, m)

      if (!global.pinterestDlState) global.pinterestDlState = {}
      global.pinterestDlState[m.sender] = {
        hls,
        title,
        desc,
        creator,
        saves,
        messageId: sent.key.id,
        timestamp: Date.now()
      }
      return
    }
    return
  }

  // ─── MODE: Search ────────────────────────────────────────────────────────
  const modeKeys = ['vid', 'video', 'gif', 'gifs', 'img', 'image', 'images']
  const mode = detectMode(args)
  const queryArgs = modeKeys.includes(args[0]?.toLowerCase()) ? args.slice(1) : args
  const query = queryArgs.join(' ')
  if (!query) throw 'Please enter a search keyword!'

  const modeLabel = { all: 'All', video: 'Video', gif: 'GIF', image: 'Image' }

  const searchResult = await pinterest.search(query, 50)

  if (!searchResult.status) {
    throw `No results found for: *${query}*`
  }

  const pins = searchResult.result.pins

  const filteredPins = pins.filter(pin => {
    const medias = extractMediaFromPin(pin)
    if (!medias) return false
    if (mode === 'all') return true
    if (mode === 'gif') {
      return medias.some(m => m.type === 'gif' || m.isGif === true)
    }
    return medias.some(m => m.type === mode)
  })

  if (!filteredPins.length) throw `No ${mode} results found for: *${query}*`

  const totalResult = filteredPins.length

  // Hanya ambil 3 untuk GIF agar tidak terlalu berat
  const maxResults = mode === 'gif' ? 3 : 10

  const shuffled = filteredPins
    .sort(() => Math.random() - 0.5)
    .slice(0, maxResults)

  const imageUrls = []
  const videoUrls = []
  const allSources = []

  for (const pin of shuffled) {
    const medias = extractMediaFromPin(pin)
    if (!medias) continue

    for (const media of medias) {
      // ─── HANDLE GIF ──────────────────────────────────────────────────────
      if (media.type === 'gif' || media.isGif === true) {
        if (mode === 'all' || mode === 'gif') {
          try {
            // Convert GIF to MP4
            const videoPath = await gifToMp4(media.url)
            const videoBuffer = fs.readFileSync(videoPath)
            fs.unlinkSync(videoPath)

            const uploadedUrl = await upload(videoBuffer, `pinterest_gif_${Date.now()}.mp4`)

            if (uploadedUrl) {
              videoUrls.push(uploadedUrl)
            }
          } catch (err) {
            console.error('GIF error:', err)
          }
        }
      }
      // ─── HANDLE IMAGE ────────────────────────────────────────────────────
      else if (media.type === 'image' && mode !== 'video') {
        imageUrls.push(media.url)
      }
      // ─── HANDLE VIDEO ────────────────────────────────────────────────────
      else if (media.type === 'video' && mode !== 'image') {
        try {
          const hls = await getPinterestHLS(media.url)
          const best = hls?.qualities?.at(-1)
          if (!best) continue
          const output = `/tmp/pin_${Date.now()}.mp4`
          await mergeVideoAudio(best.url, hls.audio, output)
          const videoBuffer = fs.readFileSync(output)
          fs.unlinkSync(output)

          const uploadedUrl = await upload(videoBuffer, `pinterest_video_${Date.now()}.mp4`)
          if (uploadedUrl) {
            videoUrls.push(uploadedUrl)
          }
        } catch (err) {
          console.error('Video error:', err)
        }
      }
    }

    allSources.push(['https://www.pinterest.com/favicon.ico', pin.pin_url, pin.title || 'Pinterest'])
  }

  // ─── Kirim dengan AiRich ──────────────────────────────────────────────
  try {
    const rich = conn.aiRich()
      .setTitle("Pinterest Search")
      .addSuggest([
        `Query: ${query}`,
        `Mode: ${modeLabel[mode] || 'All'}`,
        `Result: ${totalResult}`,
        `Showing: ${shuffled.length}`
      ])
      .addSource(allSources)

    if (imageUrls.length) rich.addImage(imageUrls)
    if (videoUrls.length) rich.addVideo(videoUrls)

    await rich.send(m.chat, { quoted:m })
  } catch (e) {
    console.error('AiRich error:', e)

    // Fallback: kirim satu per satu jika AiRich gagal
    if (videoUrls.length > 0) {
      for (const url of videoUrls) {
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer' })
          await conn.sendFile(m.chat, Buffer.from(response.data), 'video.mp4', '🎬 Pinterest GIF', m)
        } catch (err) {
          console.error('Fallback send error:', err)
        }
      }
    }
    throw e.message
  }
}

// ─── Quality Selection Handler ────────────────────────────────────────────
handler.before = async (m, { conn }) => {
  // Fix: Aman dari quoted message yang undefined/null
  if (!m.quoted || !m.quoted.id) return
  const state = global.pinterestDlState?.[m.sender]
  if (!state || Date.now() - state.timestamp > 300000) return

  // Validasi ID pesan yang di-reply
  if (state.messageId !== m.quoted.id) return

  const choice = parseInt(m.text)
  if (isNaN(choice) || choice < 1 || choice > state.hls.qualities.length) return

  try {
    const { hls, title, desc, creator, saves } = state
    const selected = hls.qualities[choice - 1]

    const infoText = `Pinterest Video\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}\n- Resolution: ${selected.resolution}`

    await m.reply(`Downloading resolution ${selected.resolution}...`)
    const output = `/tmp/pin_${Date.now()}.mp4`
    await mergeVideoAudio(selected.url, hls.audio, output)

    await conn.sendFile(m.chat, fs.readFileSync(output), 'pinterest.mp4', infoText, m)
    fs.unlinkSync(output)
    await m.reply('Video downloaded successfully!')
  } catch (err) {
    await m.reply(`Failed: ${err.message || err}`)
  }

  delete global.pinterestDlState[m.sender]
  return true
}

handler.help = ['pinterest'].map(v => v + ' <url|keyword>')
handler.tags = ['downloader']
handler.command = /^(pint(erest)?)$/i
handler.limit = true
handler.ai = { risk: 'low', description: "search/download from pinterest" }

export default handler
