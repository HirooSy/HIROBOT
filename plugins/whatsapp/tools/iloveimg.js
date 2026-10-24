import axios from 'axios'

const BASE_URL = 'https://www.iloveimg.com/upscale-image'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export async function upscaleImage(input, multiplier = 2) {
  if (!input) {
    throw new Error('Input image (Buffer or URL) is required')
  }

  const scale = [2, 4].includes(Number(multiplier)) ? String(multiplier) : '2'

  let buf = null
  if (typeof input === 'string' && input.startsWith('http')) {
    const res = await axios.get(input, { responseType: 'arraybuffer', timeout: 25000 })
    buf = Buffer.from(res.data)
  } else if (Buffer.isBuffer(input)) {
    buf = input
  }
  if (!buf) {
    throw new Error('Invalid input type. Expected Buffer or image URL')
  }

  const pageRes = await axios.get(BASE_URL, {
    headers: {
      'User-Agent': USER_AGENT
    },
    timeout: 15000
  })

  const html = pageRes.data
  const matchConfig = html.match(/var ilovepdfConfig = ({[^;]+});/)
  if (!matchConfig) {
    throw new Error('Failed to extract iLoveIMG config token')
  }

  const config = JSON.parse(matchConfig[1])
  const token = config.token
  const serverName = config.servers && config.servers.length > 0
    ? config.servers[Math.floor(Math.random() * config.servers.length)]
    : 'api1g'

  const workerServer = `https://${serverName}.iloveimg.com`

  let taskId = null
  const taskIdx = html.indexOf('ilovepdfConfig.taskId = ')
  if (taskIdx !== -1) {
    const q1 = html.indexOf("'", taskIdx)
    const q2 = html.indexOf("'", q1 + 1)
    taskId = html.substring(q1 + 1, q2)
  }

  if (!taskId) {
    throw new Error('Failed to extract pre-generated taskId')
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'Origin': 'https://www.iloveimg.com',
    'Referer': 'https://www.iloveimg.com/'
  }

  const formUpload = new FormData()
  formUpload.append('task', taskId)
  formUpload.append('file', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg')

  const uploadRes = await fetch(`${workerServer}/v1/upload`, {
    method: 'POST',
    headers,
    body: formUpload
  })
  const uploadData = await uploadRes.json()

  const serverFilename = uploadData?.server_filename
  if (!serverFilename) {
    throw new Error('Upload failed: server_filename not returned')
  }

  const formUpscale = new FormData()
  formUpscale.append('task', taskId)
  formUpscale.append('server_filename', serverFilename)
  formUpscale.append('scale', scale)

  const upscaleRes = await axios.post(`${workerServer}/v1/upscale`, formUpscale, {
    headers,
    responseType: 'arraybuffer',
    timeout: 60000
  })

  const imageBuffer = Buffer.from(upscaleRes.data)

  return {
    status: true,
    scale: `${scale}x`,
    sizeBytes: imageBuffer.length,
    sizeMB: (imageBuffer.length / (1024 * 1024)).toFixed(2),
    buffer: imageBuffer
  }
}

let handler = async (m, { conn, text, args }) => {
  let q = m.quoted ? m.quoted : m
  let mime = (q.msg || q).mimetype || q.mediaType || ''
  const urlInput = text?.trim().split(/\s+/)[0]

  if (!mime && !(urlInput && urlInput.startsWith('http'))) throw 'Reply/caption an image, or give a direct image URL, to upscale!'
  if (mime && !/image\/(jpeg|jpg|png|webp)/i.test(mime)) throw 'Media must be an image (JPG/PNG/WEBP)!'

  let multiplier = parseInt(args[args.length - 1]) || 2
  if (![2, 4].includes(multiplier)) multiplier = 2

  await m.react('⏳')

  try {
    const input = mime ? await q.download() : urlInput

    const result = await upscaleImage(input, multiplier)

    await conn.sendMessage(m.chat, {
      image: result.buffer,
      caption: `✅ Upscaled ${result.scale} (${result.sizeMB} MB)`,
      mimetype: 'image/png'
    }, { quoted: m })

    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message}`
  }
}

handler.help = ['iloveimg', 'ilimg'].map(v => v + ' [2/4]')
handler.tags = ['tools']
handler.command = /^(iloveimg|ilimg)$/i
handler.limit = true

export default handler