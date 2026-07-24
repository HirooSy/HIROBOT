import axios from 'axios'
import FormData from 'form-data'

const BASE = 'https://salman555-upscale-images.hf.space'

const MODES = {
  2: { api_name: 'upscale_x2', label: '×2' },
  4: { api_name: 'standard_upscale', label: '×4' },
  8: { api_name: 'premium_upscale', label: '×8 🚀' }
}

let handler = async (m, { conn, args }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ""
  if (!mime) throw 'Reply/caption an image to upscale!'

  if (!/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  let factor = parseInt(args[0]) || 2
  if (![2, 4, 8].includes(factor)) factor = 2
  const mode = MODES[factor]

  await m.react('⏳')

  try {
    const buffer = await q.download()

    // 1. Upload gambar ke gradio
    const uploadedPath = await uploadToGradio(buffer)

    // 2. Trigger mode upscale yang dipilih & tunggu hasil
    const resultUrl = await runUpscale(uploadedPath, mode.api_name)

    // 3. Download hasil & kirim
    const res = await axios.get(resultUrl, { responseType: 'arraybuffer', timeout: 120000 })

    await conn.sendMessage(m.chat, {
      image: Buffer.from(res.data),
      caption: `✅ Upscale ${mode.label}`,
      mimetype: 'image/png'
    }, { quoted: m })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message}`
  }
}

handler.dym = ['hd', 'upscale']
handler.help = ['hd'].map(v => v + " [2/4/8]")
handler.tags = ['tools']
handler.command = /^(hd|upscale)$/i

export default handler

// ====== Helper Functions ======

async function uploadToGradio(buffer) {
  const form = new FormData()
  form.append('files', buffer, { filename: 'input.jpg', contentType: 'image/jpeg' })

  const uploadRes = await axios.post(`${BASE}/gradio_api/upload`, form, {
    headers: form.getHeaders(),
    timeout: 60000
  })

  return uploadRes.data[0] // path string
}

async function runUpscale(uploadedPath, api_name) {
  const session_hash = Math.random().toString(36).substring(2)

  const payload = {
    data: [
      {                      // Input Image (FileData)
        path: uploadedPath,
        url: `${BASE}/gradio_api/file=${uploadedPath}`,
        orig_name: 'input.jpg',
        size: null,
        mime_type: 'image/jpeg',
        is_stream: false,
        meta: { _type: 'gradio.FileData' }
      }
    ],
    event_data: null,
    fn_index: api_name === 'upscale_x2' ? 0 : api_name === 'standard_upscale' ? 1 : 2,
    trigger_id: null,
    session_hash
  }

  const joinRes = await axios.post(`${BASE}/gradio_api/queue/join`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  })
  const event_id = joinRes.data.event_id

  const sseRes = await axios.get(`${BASE}/gradio_api/queue/data`, {
    params: { session_hash },
    responseType: 'text',
    timeout: 300000, // 5 menit
    headers: { Accept: 'text/event-stream' },
    transformResponse: [(data) => data]
  })

  const raw = sseRes.data
  const lines = raw.split('\n').filter(l => l.startsWith('data: '))

  let completedEvent = null
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6))
      if (json.event_id === event_id && json.msg === 'process_completed') {
        completedEvent = json
      }
    } catch (e) {
      // skip baris yang gagal di-parse
    }
  }

  if (!completedEvent) throw new Error('Tidak menerima hasil dari server (timeout/SSE terputus)')
  if (!completedEvent.success) throw new Error('Server gagal memproses gambar')

  // outputs: [8, 9] -> ambil komponen pertama (preview gambar)
  const outputData = completedEvent.output?.data
  if (!outputData || !outputData[0]) {
    throw new Error('Format hasil tidak sesuai ekspektasi')
  }

  const fileData = outputData[0]
  return fileData.url
}