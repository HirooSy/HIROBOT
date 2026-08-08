import path from 'path'
import fs from 'fs'
import loadVoip from '../../lib/voip/voip.js'
import axios from 'axios'
import { fileURLToPath } from 'url'

const TMP_DIR = path.join(process.cwd(), process.env.TMP || "data/tmp")

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 
const DOWNLOAD_TIMEOUT_MS = 30_000

let sharedClient = null
let connecting = null

async function getClient(conn) {
  if (sharedClient) return sharedClient
  if (connecting) return connecting

  connecting = (async () => {
    const { VoipClient } = await loadVoip()
    const client = new VoipClient({ existingSocket: conn })
    await client.connect()
    console.log('[ VOIP ] Connected (existingSocket, cached client)')
    sharedClient = client
    return client
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

// Fungsi untuk menentukan ekstensi dari mime type
function extFromMime(mime = '') {
    if (/mpeg|mp3/i.test(mime)) return '.mp3'
    if (/wav|x-wav/i.test(mime)) return '.wav'
    if (/ogg|opus/i.test(mime)) return '.ogg'
    if (/aac/i.test(mime)) return '.aac'
    if (/mp4|m4a/i.test(mime)) return '.m4a'
    return '.audio' 
}

// Download audio dari URL dengan arraybuffer
async function downloadAudioFromUrl(url) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  
  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'arraybuffer', // Gunakan arraybuffer, bukan stream
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })

  const contentType = response.headers['content-type'] || ''
  const ext = extFromMime(contentType) || '.mp3' // Default ke .mp3
  const filePath = path.join(TMP_DIR, `voip_${Date.now()}${ext}`)
  
  fs.writeFileSync(filePath, Buffer.from(response.data))
  return filePath
}

function isValidUrl(string) {
  try {
    new URL(string)
    return true
  } catch (_) {
    return false
  }
}

let busy = false

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [audio_url] (reply to an audio file or provide URL)`
  if (busy) throw 'A call is already in progress, wait for it to finish.'

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  let audioSource = 'silence'
  let audioUrl = args[1]
  let isTempFile = false
  
  // Cek audio dari URL 
  if (audioUrl && isValidUrl(audioUrl)) {
    try {
      await m.reply('✦ Downloading audio from URL...')
      audioSource = await downloadAudioFromUrl(audioUrl)
      isTempFile = true
      console.log('[ VOIP ] Audio downloaded from URL:', audioUrl)
    } catch (e) {
      throw `Failed to download audio from URL: ${e.message}`
    }
  } 
  // Cek audio dari reply
  else if (m.quoted) {
    const mime = m.quoted.mimetype || ''
    if (/audio/.test(mime)) {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
      const buffer = await m.quoted?.download()
      if (!buffer) throw 'Failed to download the replied audio.'
      const ext = extFromMime(mime) || '.audio'
      audioSource = path.join(TMP_DIR, `voip_${Date.now()}${ext}`)
      fs.writeFileSync(audioSource, buffer)
      isTempFile = true
    }
  }

  const durationMs = 60_000

  busy = true
  const cleanup = () => {
    busy = false
    if (isTempFile && audioSource !== 'silence' && fs.existsSync(audioSource)) {
      fs.unlink(audioSource, () => {})
    }
  }

  try {
    const client = await getClient(conn)
    console.log('[ VOIP ] dialing', phoneNumber)

    const { key } = await m.reply(`✦ Calling ${phoneNumber}...`)

    // Pastikan audio file benar-benar ada sebelum call
    if (audioSource !== 'silence' && !fs.existsSync(audioSource)) {
      throw new Error(`Audio file not found: ${audioSource}`)
    }

    console.log('[ VOIP ] Audio source:', audioSource)
    const call = await client.call(phoneNumber, { audioSource, durationMs })
    console.log('[ VOIP ] call() resolved, callId=', call.callId)

    call.on('ringing', () => {
      console.log('[ VOIP ] event: ringing')
      conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
    })
    call.on('connected', () => {
      console.log('[ VOIP ] event: connected')
      conn.sendMessage(m.chat, { text: `✦ Call connected. Auto-hangup in ${durationMs / 1000}s.`, edit: key })
    })
    call.on('ended', (reason) => {
      console.log('[ VOIP ] event: ended, reason=', reason)
      conn.sendMessage(m.chat, { text: `✦ Call ended: ${reason}`, edit: key })
      cleanup()
    })
    call.on('error', (err) => {
      console.error('[ VOIP ] event: error', err)
      conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
      cleanup()
    })
  } catch (e) {
    console.error('[ VOIP ] call() threw before/during setup:', e)
    cleanup()
    throw e
  }
}

handler.help = ['call <number> [audio_url] (reply to audio or provide URL)']
handler.tags = ['owner']
handler.command = /^(call|voipcall)$/i
handler.rowner = true

export default handler