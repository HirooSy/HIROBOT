import fs from 'fs'
import axios from 'axios'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import http2 from 'http2'
const execFileAsync = promisify(execFile)
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

const FFMPEG_PATH = '/usr/bin/ffmpeg'
const PREVIEW_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const PREVIEW_CONCURRENCY = 30

const isGifUrl = (u) => /\.gif(\?|$)/i.test(u || '')

const escapeHtml = (str = '') => String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function createFetcher() {
  const sessions = new Map()
  let h2Broken = false

  const getSession = (origin) => {
    let session = sessions.get(origin)
    if (session && !session.closed && !session.destroyed) return session
    session = http2.connect(origin)
    session.on('error', () => sessions.delete(origin))
    session.on('close', () => sessions.delete(origin))
    sessions.set(origin, session)
    return session
  }

  const headers = { 'user-agent': PREVIEW_UA, 'accept': 'image/*,*/*', 'referer': 'https://id.pinterest.com/' }

  const viaHttp2 = (url) => new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = getSession(u.origin).request({ ':path': u.pathname + u.search, ...headers })
    const chunks = []
    let status = 0
    let type = ''
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL)
      reject(new Error('timeout'))
    }, 10000)
    req.on('response', (h) => {
      status = h[':status']
      type = h['content-type'] || ''
    })
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      clearTimeout(timer)
      if (status === 200) return resolve({ data: Buffer.concat(chunks), type })
      reject(Object.assign(new Error(`HTTP ${status}`), { response: { status } }))
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })

  const viaAxios = async (url) => {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': PREVIEW_UA, referer: 'https://id.pinterest.com/' }
    })
    return { data: res.data, type: res.headers?.['content-type'] || '' }
  }

  return {
    async get(url) {
      if (!h2Broken) {
        try {
          return await viaHttp2(url)
        } catch (e) {
          if (e.response?.status >= 400) throw e
          h2Broken = true
        }
      }
      return viaAxios(url)
    },
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    }
  }
}

async function fetchToFile(url, file, fetcher) {
  const res = await fetcher.get(url)
  if (!res.data?.length) throw new Error('empty response')
  fs.writeFileSync(file, res.data)
  return String(res.type || '').split(';')[0].trim()
}

async function firstFrame(input, output) {
  const args = ['-y']
  if (/^https?:\/\//i.test(input)) {
    args.push('-user_agent', PREVIEW_UA, '-headers', 'referer: https://id.pinterest.com/\r\norigin: https://id.pinterest.com/\r\n')
  }
  args.push('-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', output)
  await execFileAsync(FFMPEG_PATH, args, { timeout: 30000 })
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('empty frame')
}

const smallThumb = (u) => /i\.pinimg\.com\/(474x|736x|originals|orig)\//i.test(u)
  ? u.replace(/i\.pinimg\.com\/(474x|736x|originals|orig)\//i, 'i.pinimg.com/236x/')
  : u

async function savePreview(item, dir, idx, fetcher) {
  const out = join(dir, `pin_${idx}.jpg`)

  const still = item.thumbUrl && !isGifUrl(item.thumbUrl) ? item.thumbUrl
    : (item.type === 'image' && !isGifUrl(item.rawUrl) ? item.rawUrl : null)

  if (still) {
    const small = smallThumb(still)
    try {
      await fetchToFile(small, out, fetcher)
    } catch (e) {
      if (small === still) throw e
      await fetchToFile(still, out, fetcher)
    }
    return out
  }

  if (item.type === 'gif') {
    const guess = smallThumb(item.thumbUrl || item.rawUrl).replace(/\.gif(\?.*)?$/i, '.jpg')
    try {
      const type = await fetchToFile(guess, out, fetcher)
      if (/^image\/jpe?g$/i.test(type)) return out
    } catch {}
  }

  if (item.type === 'gif' || item.type === 'video') {
    await firstFrame(item.rawUrl, out)
    return out
  }

  throw new Error('no preview source')
}

async function downloadPreviews(items, dir) {
  const fetcher = createFetcher()
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        items[i].localPath = await savePreview(items[i], dir, i, fetcher)
      } catch {
        items[i].localPath = null
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, items.length) }, worker))
  } finally {
    fetcher.close()
  }
}

function localImgSrc(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
}

function buildPreviewHtml(items) {
  const typeLabel = { gif: 'GIF', video: 'VIDEO' }
  const cells = items.map((item, i) => `
    <div class="cell">
      <img src="${localImgSrc(item.localPath)}" alt="${i + 1}">
      <span class="num">${i + 1}</span>
      ${typeLabel[item.type] ? `<span class="tag">${typeLabel[item.type]}</span>` : ''}
    </div>`).join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { padding: 8px; font-family: sans-serif; background: transparent; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .cell { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: rgba(128,128,128,.2); }
  .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .num { position: absolute; top: 6px; left: 6px; min-width: 24px; padding: 2px 7px; border-radius: 12px; background: rgba(0,0,0,.65); color: #fff; font-size: 12px; font-weight: 700; text-align: center; }
  .tag { position: absolute; bottom: 6px; right: 6px; padding: 2px 6px; border-radius: 6px; background: rgba(230,0,35,.9); color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .5px; }
</style>
</head>
<body>
  <div class="grid">${cells}
  </div>
</body>
</html>`
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

  await m.react('⏳')

  const dir = fs.mkdtempSync(join(tmpdir(), 'pin_'))

  try {
    await downloadPreviews(items, dir)

    const readyItems = items.filter(item => item.localPath)
    if (!readyItems.length) throw `Failed to load previews for: *${query}*`

    cleanupSearchState()
    const token = `${(m.sender || '').split('@')[0]}_${Date.now().toString(36)}`
    global.pinterestSearchState[token] = { items: readyItems, query, mode, timestamp: Date.now() }

    const typeLabel = { image: 'Image', gif: 'GIF', video: 'Video' }

    const rows = readyItems.map((item, i) => ({
      header: `${i + 1}. ${typeLabel[item.type] || 'Media'}`,
      title: (item.title || query).slice(0, 60),
      description: '',
      id: `.${command} get ${token} ${i}`
    }))

    const caption = `- *Query:* ${query}\n- Mode: ${modeLabel[mode] || 'All'}\n- Result: ${totalResult}\n- Showing: ${readyItems.length}\n\nChoose the number you want to download.`

    await conn.aiRich()
      .setTitle(`Pinterest — ${query}`)
      .addHtml(buildPreviewHtml(readyItems))
      .send(m.chat, { quoted: m })

    await conn.sendButton(m.chat, {
      text: caption,
      footer: 'Pinterest',
      nativeFlow: [{ text: 'Select', sections: [{ rows }] }]
    }, m)

    await m.react('✅')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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