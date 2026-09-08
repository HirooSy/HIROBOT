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

  // Now shows up to 50 mixed items (image+gif+video), matching e621's
  // gallery size. Unlike before, gif/video are NOT converted+uploaded here
  // - that's expensive (ffmpeg + upload) and doing it for up to 50 items
  // up front would make search painfully slow. Instead we keep the raw
  // pin reference and only convert+upload when someone actually clicks
  // Download on that specific item (see the token's run() below).
  const maxResults = 50

  const shuffled = filteredPins
    .sort(() => Math.random() - 0.5)
    .slice(0, maxResults)

  // Each entry: { type: 'image'|'gif'|'video', rawUrl, pinUrl, title }
  const items = []
  const allSources = []

  for (const pin of shuffled) {
    const medias = extractMediaFromPin(pin)
    if (!medias) continue

    for (const media of medias) {
      if ((media.type === 'gif' || media.isGif === true) && (mode === 'all' || mode === 'gif')) {
        items.push({ type: 'gif', rawUrl: media.url, pinUrl: pin.pin_url, title: pin.title });
      } else if (media.type === 'image' && mode !== 'video') {
        items.push({ type: 'image', rawUrl: media.url, pinUrl: pin.pin_url, title: pin.title });
      } else if (media.type === 'video' && mode !== 'image') {
        items.push({ type: 'video', rawUrl: media.url, pinUrl: pin.pin_url, title: pin.title });
      }
    }

    allSources.push(['https://www.pinterest.com/favicon.ico', pin.pin_url, pin.title || 'Pinterest'])
  }

  // ─── Resolve preview thumbnails ─────────────────────────────────────────
  // Images: previewed through the bot's own /api/proxy-image endpoint (same
  // fix used for e621) instead of downloading+base64-encoding every item up
  // front - keeps this fast even at 50 items.
  // Gif/video: ffmpeg grabs the first frame directly from the raw media URL
  // (no conversion/upload needed just to preview it) and that gets embedded
  // as base64, since it's a local file either way once ffmpeg's done with it.
  async function resolveThumb(item) {
    if (item.type === 'image') return item.rawUrl; // proxied client-side
    try {
      const buf = await extractFirstFrame(item.rawUrl)
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    } catch (err) {
      console.error(`${item.type} first-frame error:`, err.message)
      return ''
    }
  }
  const thumbs = await Promise.all(items.map(resolveThumb))

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

    if (items.length) {
      const token = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
          const i = Number(args?.index) || 0
          const item = items[i]
          if (!item) throw new Error('Nothing to send.')
          const caption = item.title ? `Pinterest — ${item.title}` : `Pinterest — ${query}`

          if (item.type === 'image') {
            await conn.sendFile(chatId, item.rawUrl, 'pinterest.jpg', caption, null)
            return { message: 'Sent to chat.' }
          }

          if (item.type === 'gif') {
            // Convert+upload only happens now, on click - not for all 50
            // items up front.
            const videoPath = await gifToMp4(item.rawUrl)
            try {
              const videoBuffer = fs.readFileSync(videoPath)
              await conn.sendFile(chatId, videoBuffer, 'pinterest.mp4', caption, null)
            } finally {
              fs.unlinkSync(videoPath)
            }
            return { message: 'Sent to chat.' }
          }

          if (item.type === 'video') {
            const hls = await getPinterestHLS(item.rawUrl)
            const best = hls?.qualities?.at(-1)
            if (!best) throw new Error('No video quality available.')
            const output = join(tmpdir(), `pin_dl_${Date.now()}.mp4`)
            try {
              await mergeVideoAudio(best.url, hls.audio, output)
              const videoBuffer = fs.readFileSync(output)
              await conn.sendFile(chatId, videoBuffer, 'pinterest.mp4', caption, null)
            } finally {
              if (fs.existsSync(output)) fs.unlinkSync(output)
            }
            return { message: 'Sent to chat.' }
          }

          throw new Error('Unknown item type.')
        }
      })
      const thumbToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
          const url = args?.url
          if (!url || typeof url !== 'string') throw new Error('Missing url.')
          const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 })
          const mime = url.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg'
          return { dataUri: `data:${mime};base64,${Buffer.from(res.data).toString('base64')}` }
        }
      })
      const rawServer = typeof global.opts?.server === 'string' ? global.opts.server : ''
      const apiBase = rawServer.replace(/\/$/, '')
      const apiHost = apiBase.replace(/^https?:\/\//, '')
      const types = items.map(it => it.type)
      rich.addHtml(buildGalleryHtml(thumbs, types, query, token, thumbToken, apiBase), { trustedSources: apiHost ? [apiHost] : [] })
    }

    await rich.send(m.chat, { quoted:m })
  } catch (e) {
    console.error('AiRich error:', e)
    throw e.message
  }
}

function buildGalleryHtml(thumbs, types, query, token, thumbToken, apiBase) {
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
.spinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:36px;height:36px;border:3px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;display:none}
@keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
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
      <div class="spinner" id="spinner"></div>
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
const thumbs = ${JSON.stringify(thumbs)};
const types = ${JSON.stringify(types)};
const token = ${JSON.stringify(token || '')};
const thumbToken = ${JSON.stringify(thumbToken || '')};
const apiBase = ${JSON.stringify(httpsApiBase)};
let idx = 0;

function proxify(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  return apiBase ? apiBase + '/api/proxy-image?url=' + encodeURIComponent(url) : url;
}

const imgEl = document.getElementById('img');
const spinnerEl = document.getElementById('spinner');
const counterEl = document.getElementById('counter');
const playIconEl = document.getElementById('playIcon');
const dlBtn = document.getElementById('dl');

function render(){
  const raw = thumbs[idx];
  const src = proxify(raw);
  let retried = false;
  imgEl.style.visibility = 'hidden';
  spinnerEl.style.display = 'block';
  imgEl.onload = () => {
    spinnerEl.style.display = 'none';
    imgEl.style.visibility = 'visible';
  };
  imgEl.onerror = async () => {
    if (!retried) {
      retried = true;
      setTimeout(() => {
        imgEl.src = src + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
      }, 800);
      return;
    }
    if (thumbToken && raw && !raw.startsWith('data:')) {
      const result = await sendAction({ type: 'aiRichAction', token: thumbToken, url: raw });
      if (result.success && result.dataUri) { imgEl.src = result.dataUri; return; }
    }
    spinnerEl.style.display = 'none';
    imgEl.style.visibility = 'visible';
  };
  imgEl.src = src;
  const typeLabel = types[idx] === 'video' ? 'Video' : (types[idx] === 'gif' ? 'GIF' : 'Image');
  counterEl.textContent = (idx + 1) + ' / ' + thumbs.length + '  —  ' + typeLabel;
  playIconEl.style.display = (types[idx] === 'video' || types[idx] === 'gif') ? 'flex' : 'none';
}
document.getElementById('prev').addEventListener('click', () => { idx = (idx - 1 + thumbs.length) % thumbs.length; render(); });
document.getElementById('next').addEventListener('click', () => { idx = (idx + 1) % thumbs.length; render(); });

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