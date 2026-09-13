import axios from 'axios'

const API_BASE = 'https://api.ezremove.ai/api/ez-remove/v3/background-remove'
const VALID_MODES = ['general_v1', 'general_v2', 'logo', 'text', 'anime', 'custom']

function randomSerial() {
  let s = ''
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

export async function ezRemove(input) {
  try {
    const mode = (input?.mode ?? 'general_v1').toLowerCase()
    if (!VALID_MODES.includes(mode)) {
      return { Status: false, Code: 400, Input: input, Result: null,
        Error: `Invalid mode "${mode}". Use: ${VALID_MODES.join(', ')}` }
    }

    let imageBytes, contentType, fileName
    if (Buffer.isBuffer(input?.imageBuffer)) {
      imageBytes = new Uint8Array(input.imageBuffer)
      contentType = input.contentType || 'image/png'
      fileName = 'input.png'
    } else if (typeof input?.imageUrl === 'string' && input.imageUrl.trim()) {
      const imgRes = await fetch(input.imageUrl)
      if (!imgRes.ok) {
        return { Status: false, Code: imgRes.status, Input: input, Result: null,
          Error: `Image download HTTP ${imgRes.status}` }
      }
      const ab = await imgRes.arrayBuffer()
      imageBytes = new Uint8Array(ab)
      contentType = imgRes.headers.get('content-type') || 'image/png'
      try {
        const u = new URL(input.imageUrl)
        fileName = u.pathname.split('/').filter(Boolean).pop() || 'input.png'
      } catch { fileName = 'input.png' }
    } else {
      return { Status: false, Code: 400, Input: input, Result: null,
        Error: "Provide 'imageBuffer' or 'imageUrl'." }
    }

    if (imageBytes.length < 100) {
      return { Status: false, Code: 400, Input: input, Result: null,
        Error: 'Image too small (min ~64x64 pixels recommended).' }
    }

    const serial = randomSerial()
    const baseHeaders = {
      'Product-Serial': serial,
      Origin: 'https://ezremove.ai',
      Referer: 'https://ezremove.ai/',
    }

    const form = new FormData()
    form.append('image_file', new Blob([imageBytes], { type: contentType }), fileName)
    form.append('mode', mode)
    if (input?.params && typeof input.params === 'object') {
      form.append('params', JSON.stringify(input.params))
    }

    const createRes = await fetch(`${API_BASE}/create-job`, {
      method: 'POST',
      headers: baseHeaders,
      body: form,
    })
    const createData = await createRes.json()

    if (createRes.status !== 200 || !createData?.result?.job_id) {
      return { Status: false, Code: createRes.status, Input: input, Result: null,
        Error: `Create job failed: ${JSON.stringify(createData).slice(0, 250)}` }
    }

    const jobId = createData.result.job_id
    const inputUrl = createData.result.image_url

    let pollResult = null
    let lastStatus = null
    const startedAt = Date.now()
    const MAX_POLL_MS = 40_000
    let delay = 1000
    while (Date.now() - startedAt < MAX_POLL_MS) {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay + 500, 3000)
      try {
        const pollRes = await fetch(`${API_BASE}/get-job/${jobId}`, { headers: baseHeaders })
        if (!pollRes.ok) continue
        const pollData = await pollRes.json()
        const status = pollData?.result?.status
        lastStatus = status
        if (status === 2) { pollResult = pollData.result; break }
        if (status === 3) {
          return { Status: false, Code: 502, Input: input, Result: null,
            Error: `Processing error: ${pollData?.result?.error ?? 'unknown'}` }
        }
      } catch (_) { }
    }

    if (!pollResult) {
      return {
        Status: false, Code: 504, Input: input,
        Error: `Polling timeout (>40s). lastStatus=${lastStatus}. Job ID: ${jobId}`,
        Result: { jobId, inputUrl, productSerial: serial },
      }
    }

    const previews = Array.isArray(pollResult.output?.preview) ? pollResult.output.preview : []
    const maxQuality = Array.isArray(pollResult.output?.max) ? pollResult.output.max : []
    return {
      Status: true,
      Code: 200,
      Input: { mode, params: input?.params },
      Result: {
        message: `Background removed (mode: ${mode}) — ${previews.length} preview URL ready`,
        jobId,
        mode,
        inputUrl,
        preview: previews[0] ?? null,
        previewAll: previews,
        maxQuality: maxQuality[0] ?? null,
        maxQualityAll: maxQuality,
        productSerial: serial,
      },
    }
  } catch (e) {
    return {
      Status: false,
      Code: e.response?.status ?? 500,
      Input: input,
      Result: null,
      Error: e.message ?? String(e),
    }
  }
}

let handler = async (m, { conn, text, args, usedPrefix, command }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ''
  const rawArg = (text || '').trim().split(/\s+/)[0] || ''
  const isUrlArg = rawArg.startsWith('http')
  const modeArg = args.find(a => VALID_MODES.includes(a.toLowerCase()))?.toLowerCase()

  if (!mime && !isUrlArg) {
    return conn.reply(
      m.chat,
      `Reply/caption an image, or give a direct image URL, to remove its background.\n\n- ${usedPrefix + command} (reply to an image)\n- ${usedPrefix + command} <image_url>\n- ${usedPrefix + command} <mode> (reply to an image)\n\nModes: ${VALID_MODES.join(', ')}`,
      m
    )
  }
  if (mime && !/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  await m.react('⏳')

  try {
    const ezInput = mime
      ? { imageBuffer: await q.download(), mode: modeArg }
      : { imageUrl: rawArg, mode: modeArg }

    const result = await ezRemove(ezInput)

    if (!result.Status) {
      await m.react('❌')
      throw result.Error
    }

    const outUrl = result.Result.maxQuality || result.Result.preview
    if (!outUrl) {
      await m.react('❌')
      throw 'The server did not return a result URL.'
    }

    const res = await axios.get(outUrl, { responseType: 'arraybuffer', timeout: 60000 })

    await conn.sendMessage(m.chat, {
      image: Buffer.from(res.data),
      caption: `✅ Background removed (${result.Result.mode})`,
      mimetype: 'image/png'
    }, { quoted: m })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message || error}`
  }
}

handler.help = ['removebg']
handler.tags = ['tools']
handler.command = /^(removebg)$/i
handler.limit = true

export default handler
