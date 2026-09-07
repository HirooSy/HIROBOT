import axios from 'axios'
import fs from 'fs'
import { spawn } from 'child_process'
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

async function extractFirstFrame(videoUrl) {
  const outPath = join(tmpdir(), `pin_frame_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', videoUrl, '-vframes', '1', '-q:v', '4', outPath])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`)))
    proc.on('error', reject)
  })
  const buf = await fs.promises.readFile(outPath)
  fs.promises.unlink(outPath).catch(() => {})
  return buf
}

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

  // ─── Download Media & Build HTML Gallery ────────────────────────────────
  // Downscale + recompress previews before embedding: full-resolution media
  // as raw base64 can easily blow the message payload past what Baileys'
  // websocket write can handle in one shot (was causing write EPIPE /
  // connection drops on the whole session, not just this one message).
  // The full-resolution/original media URL is kept separately for the
  // "Download" button, since the embedded copy is a deliberately small
  // preview. Videos are represented by their first frame in the gallery;
  // "Download" on a video item still sends the actual video file.
  //
  // Downloaded in parallel (not one-by-one) since these are independent
  // network+CPU operations - was a big chunk of why search felt slow.
  const sharp = (await import('sharp')).default
  const MAX_TOTAL_BASE64_CHARS = 2_000_000

  const mediaItems = [
    ...imageUrls.map(url => ({ type: 'image', url })),
    ...videoUrls.map(url => ({ type: 'video', url }))
  ]

  const downloaded = await Promise.all(mediaItems.map(async (item) => {
    try {
      let rawBuffer
      if (item.type === 'video') {
        rawBuffer = await extractFirstFrame(item.url)
      } else {
        const res = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 15000 })
        rawBuffer = Buffer.from(res.data)
      }
      const resized = await sharp(rawBuffer)
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer()
      return { type: item.type, url: item.url, dataUri: `data:image/jpeg;base64,${resized.toString('base64')}` }
    } catch (err) {
      console.error(`${item.type} preview error:`, err.message)
      return null
    }
  }))

  const galleryImages = []
  const galleryFullUrls = []
  const galleryTypes = []
  let totalChars = 0
  for (const item of downloaded) {
    if (!item) continue
    if (totalChars + item.dataUri.length > MAX_TOTAL_BASE64_CHARS) break
    galleryImages.push(item.dataUri)
    galleryFullUrls.push(item.url)
    galleryTypes.push(item.type)
    totalChars += item.dataUri.length
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

    if (galleryImages.length) {
      const token = global.registerHtmlAction({
        chatId: m.chat,
        action: 'sendFile',
        payload: { urls: galleryFullUrls, types: galleryTypes, caption: `Pinterest — ${query}` },
        singleUse: false
      })
      const rawServer = typeof global.opts?.server === 'string' ? global.opts.server : ''
      const apiBase = rawServer.replace(/\/$/, '')
      const apiHost = apiBase.replace(/^https?:\/\//, '')
      rich.addHtml(buildGalleryHtml(galleryImages, galleryTypes, query, token, apiBase), { trustedSources: apiHost ? [apiHost] : [] })
    }

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

function buildGalleryHtml(images, types, query, token, apiBase) {
  const httpsApiBase = apiBase ? apiBase.replace(/^http:\/\//, 'https://') : ''
  return `<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
body{margin:0;background:transparent;font-family:Arial,sans-serif;color:#fff;touch-action:manipulation}
.wrap{width:100%;max-width:620px;margin:auto;padding:14px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:18px;overflow:hidden;box-shadow:0 10px 35px rgba(0,0,0,.35)}
.head{padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.1)}
.head small{display:block;font-size:10px;letter-spacing:2px;color:#888}
.head b{font-size:18px}
.stage{position:relative;background:#000;aspect-ratio:1/1}
.stage img{width:100%;height:100%;display:block;object-fit:contain;background:#000}
.playIcon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:22px;pointer-events:none}
.nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(0,0,0,.45);color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.nav.prev{left:10px}
.nav.next{right:10px}
.bottom{padding:10px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.counter{font-size:12px;color:#999}
.dl{background:#00a884;border:none;border-radius:20px;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;cursor:pointer}
.dl:disabled{opacity:.55}
</style>
<div class="wrap">
  <div class="card">
    <div class="head"><small>PINTEREST</small><b>${query.replace(/[<>&]/g, '')}</b></div>
    <div class="stage">
      <img id="img" src="">
      <div class="playIcon" id="playIcon" style="display:none">&#9654;</div>
      <div class="nav prev" id="prev">&lsaquo;</div>
      <div class="nav next" id="next">&rsaquo;</div>
    </div>
    <div class="bottom">
      <span class="counter" id="counter"></span>
      <button class="dl" id="dl">Download</button>
    </div>
  </div>
</div>
<script>
const images = ${JSON.stringify(images)};
const types = ${JSON.stringify(types)};
const token = ${JSON.stringify(token || '')};
const apiBase = ${JSON.stringify(httpsApiBase)};
let idx = 0;
const imgEl = document.getElementById('img');
const counterEl = document.getElementById('counter');
const playIconEl = document.getElementById('playIcon');
const dlBtn = document.getElementById('dl');
function render(){
  imgEl.src = images[idx];
  const typeLabel = types[idx] === 'video' ? 'Video' : 'Image';
  counterEl.textContent = (idx + 1) + ' / ' + images.length + '  —  ' + typeLabel;
  playIconEl.style.display = types[idx] === 'video' ? 'flex' : 'none';
}
document.getElementById('prev').addEventListener('click', () => { idx = (idx - 1 + images.length) % images.length; render(); });
document.getElementById('next').addEventListener('click', () => { idx = (idx + 1) % images.length; render(); });

let ws = null;
let wsReady = false;
let pingTimer = null;
const pending = new Map();

function connectWs() {
  if (!apiBase) return;
  const wsUrl = apiBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    wsReady = false;
    return;
  }

  ws.onopen = () => {
    wsReady = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'aiRichActionResult' && pending.has(msg.requestId)) {
      pending.get(msg.requestId)(msg);
      pending.delete(msg.requestId);
    }
  };

  ws.onclose = () => {
    wsReady = false;
    if (pingTimer) clearInterval(pingTimer);
    setTimeout(connectWs, 1500);
  };

  ws.onerror = () => {
    wsReady = false;
  };
}
connectWs();

function sendAction(payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ success: false, message: 'Not connected' });
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ success: false, message: 'Timed out' });
    }, timeoutMs);
    pending.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ ...payload, requestId }));
  });
}

dlBtn.addEventListener('click', async () => {
  if (!token) { dlBtn.textContent = 'Unavailable'; return; }
  dlBtn.disabled = true;
  dlBtn.textContent = 'Sending...';
  const result = await sendAction({ type: 'aiRichAction', token, index: idx });
  dlBtn.textContent = result.success ? 'Sent!' : ('Failed: ' + (result.message || 'unknown'));
  setTimeout(() => { dlBtn.disabled = false; dlBtn.textContent = 'Download'; }, 3000);
});
render();
</script>`
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
