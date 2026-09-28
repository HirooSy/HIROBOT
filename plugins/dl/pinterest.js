import fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

if (!global.pinterestSearchState) global.pinterestSearchState = {}

const SEARCH_STATE_TTL = 15 * 60 * 1000

function cleanupSearchState() {
  const now = Date.now()
  for (const key of Object.keys(global.pinterestSearchState)) {
    if (now - global.pinterestSearchState[key].timestamp > SEARCH_STATE_TTL) {
      delete global.pinterestSearchState[key]
    }
  }
}

function buildPreviewGrid(items, perRow = 5) {
  const rows = []
  for (let r = 0; r < items.length; r += perRow) {
    const rowItems = items.slice(r, r + perRow).map((item, j) => {
      const idx = r + j
      const thumb = item.thumbUrl || (item.type === 'image' ? item.rawUrl : '')
      return {
        column: [
          thumb ? { image: thumb, fit: 'cover', variant: 'avatar' } : { text: '[no preview]', variant: 'caption' },
          { text: String(idx + 1), variant: 'caption' }
        ],
        align: 'center'
      }
    })
    rows.push({ row: rowItems, justify: 'spaceBetween', align: 'start' })
  }
  return rows
}

async function downloadItem(conn, chatId, quoted, item, caption) {
  if (item.type === 'image') {
    await conn.sendFile(chatId, item.rawUrl, 'pinterest.jpg', caption, quoted)
    return
  }

  if (item.type === 'gif') {
    const videoPath = await gifToMp4(item.rawUrl)
    try {
      await conn.sendFile(chatId, fs.readFileSync(videoPath), 'pinterest.mp4', caption, quoted)
    } finally {
      fs.unlinkSync(videoPath)
    }
    return
  }

  if (item.type === 'video') {
    const hls = await getPinterestHLS(item.rawUrl)
    const best = hls?.qualities?.at(-1)
    if (!best) throw new Error('No video quality available.')
    const output = join(tmpdir(), `pin_dl_${Date.now()}.mp4`)
    try {
      await mergeVideoAudio(best.url, hls.audio, output)
      await conn.sendFile(chatId, fs.readFileSync(output), 'pinterest.mp4', caption, quoted)
    } finally {
      if (fs.existsSync(output)) fs.unlinkSync(output)
    }
    return
  }

  throw new Error('Unknown item type.')
}

let handler = async (m, { conn, args, command }) => {
  if (!args[0]) throw `Usage:\n\n*Download by URL:*\n.pin https://pinterest.com/pin/xxx\n.pin https://pin.it/xxx\n\n*Search:*\n.pin <keyword>\n.pin video <keyword>\n.pin image <keyword>\n.pin gif <keyword>`

  const firstArg = args[0]

  if (firstArg === 'get') {
    const token = args[1]
    const index = Number(args[2])
    const state = global.pinterestSearchState[token]
    if (!state) throw 'This search result has expired, please search again.'
    const item = state.items[index]
    if (!item) throw 'Item not found.'

    await m.react('⬇️')
    const caption = item.title ? `Pinterest — ${item.title}` : `Pinterest — ${state.query}`
    try {
      await downloadItem(conn, m.chat, m, item, caption)
      await m.react('✅')
    } catch (error) {
      await m.react('❌')
      throw `Failed to download: ${error.message || error}`
    }
    return
  }

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

  const maxResults = 30

  const shuffled = filteredPins
    .sort(() => Math.random() - 0.5)
    .slice(0, maxResults)

  const items = []

  for (const pin of shuffled) {
    const medias = extractMediaFromPin(pin)
    if (!medias) continue

    for (const media of medias) {
      if ((media.type === 'gif' || media.isGif === true) && (mode === 'all' || mode === 'gif')) {
        items.push({ type: 'gif', rawUrl: media.url, thumbUrl: media.thumbnailUrl, pinUrl: pin.pin_url, title: pin.title });
      } else if (media.type === 'image' && mode !== 'video') {
        items.push({ type: 'image', rawUrl: media.url, thumbUrl: media.thumbnailUrl, pinUrl: pin.pin_url, title: pin.title });
      } else if (media.type === 'video' && mode !== 'image') {
        items.push({ type: 'video', rawUrl: media.url, thumbUrl: media.thumbnailUrl, pinUrl: pin.pin_url, title: pin.title });
      }
    }
  }

  if (!items.length) throw `No ${mode} results found for: *${query}*`

  cleanupSearchState()
  const token = `${(m.sender || '').split('@')[0]}_${Date.now().toString(36)}`
  global.pinterestSearchState[token] = { items, query, mode, timestamp: Date.now() }

  const typeLabel = { image: 'Image', gif: 'GIF', video: 'Video' }

  const rows = items.map((item, i) => ({
    header: `${i + 1}. ${typeLabel[item.type] || 'Media'}`,
    title: (item.title || query).slice(0, 60),
    description: '',
    id: `.${command} get ${token} ${i}`
  }))

  const caption = `- *Query:* ${query}\n- Mode: ${modeLabel[mode] || 'All'}\n- Result: ${totalResult}\n- Showing: ${items.length}`

  const widgetItems = [
    ...buildPreviewGrid(items, 5)
  ]

  await conn.sendButton(m.chat, {
    text: caption,
    footer: 'Pinterest',
    widget: { align: 'center', items: widgetItems, fallback: "Can't load preview, try to use this command in private chat" },
    nativeFlow: [{ text: 'Select', sections: [{ rows }] }]
  }, m)
}

handler.before = async (m, { conn }) => {
  if (!m.quoted || !m.quoted.id) return
  const state = global.pinterestDlState?.[m.sender]
  if (!state || Date.now() - state.timestamp > 300000) return

  if (state.messageId !== m.quoted.id) return

  const choice = parseInt(m.text)
  if (isNaN(choice) || choice < 1 || choice > state.hls.qualities.length) return

  try {
    const { hls, title, desc, creator, saves } = state
    const selected = hls.qualities[choice - 1]

    const infoText = `${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}\n- Resolution: ${selected.resolution}`

    await m.react(`⬇️`)
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