import path from 'path'
import fs from 'fs'
import loadVoip from '../../lib/voip/voip.js'
import axios from 'axios'
import { fileURLToPath } from 'url'

let _ffmpeg = null
let _ffmpegError = null
async function getFfmpeg() {
  if (_ffmpeg) return _ffmpeg
  if (_ffmpegError) throw _ffmpegError
  try {
    _ffmpeg = (await import('fluent-ffmpeg')).default
    return _ffmpeg
  } catch (err) {
    _ffmpegError = new Error(`Modul "fluent-ffmpeg" gagal dimuat (durasi audio tidak dapat dideteksi): ${err.message}`)
    throw _ffmpegError
  }
}

/**
 * Get audio duration in milliseconds using ffprobe.
 * Returns null if duration cannot be determined (falls back to no auto-hangup).
 */
async function getAudioDurationMs(filePath) {
  try {
    const ffmpeg = await getFfmpeg()
    const durationSec = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err)
        const duration = metadata?.format?.duration
        if (!duration || isNaN(duration)) return reject(new Error('Duration not found in ffprobe metadata'))
        resolve(duration)
      })
    })
    return Math.ceil(durationSec * 1000)
  } catch (e) {
    console.error('[ VOIP ] ffprobe failed to read duration:', e.message)
    return null
  }
}

const TMP_DIR = path.join(process.cwd(), process.env.TMP || "data/tmp")

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 
const DOWNLOAD_TIMEOUT_MS = 30_000

let sharedClient = null
let connecting = null
let activeCalls = new Map() // Track active calls

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

/**
 * The underlying SDK never clears its private #activeCall after a call ends,
 * so a cached VoipClient permanently refuses subsequent calls with
 * "A call is already active." Force a full disconnect/reset after every call
 * so the next .voipcall gets a fresh client with clean internal state.
 */
function resetClient() {
  if (sharedClient) {
    try {
      sharedClient.disconnect()
    } catch (e) {
      console.error('[ VOIP ] Error disconnecting stale client:', e?.message || e)
    }
  }
  sharedClient = null

  const before = process.memoryUsage()
  console.log(`[ VOIP ] Memory before GC: rss=${(before.rss / 1024 / 1024).toFixed(1)}MB heapUsed=${(before.heapUsed / 1024 / 1024).toFixed(1)}MB`)

  if (global.gc) {
    global.gc()
    const after = process.memoryUsage()
    console.log(`[ VOIP ] Memory after forced GC: rss=${(after.rss / 1024 / 1024).toFixed(1)}MB heapUsed=${(after.heapUsed / 1024 / 1024).toFixed(1)}MB`)
  } else {
    console.log('[ VOIP ] global.gc not available — start Node with --expose-gc to enable forced GC diagnostics.')
  }
}

function extFromMime(mime = '') {
    if (/mpeg|mp3/i.test(mime)) return '.mp3'
    if (/wav|x-wav/i.test(mime)) return '.wav'
    if (/ogg|opus/i.test(mime)) return '.ogg'
    if (/aac/i.test(mime)) return '.aac'
    if (/mp4|m4a/i.test(mime)) return '.m4a'
    return '.audio' 
}

async function downloadAudioFromUrl(url) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  
  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })

  const contentType = response.headers['content-type'] || ''
  const ext = extFromMime(contentType) || '.mp3'
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
  // Handle voipend (hangup)
  if (command === 'voipend') {
    if (args[0] === 'force') {
      busy = false
      resetClient()
      activeCalls.clear()
      return void (await m.reply('✦ VOIP state force-reset.'))
    }
    const chatId = m.chat
    if (!activeCalls.has(chatId)) {
      throw `❌ No active call in this chat.${busy ? '\n\nBusy flag is stuck on — try `.voipend force` to reset it.' : ''}`
    }
    const { call, key, phoneNumber, cleanup } = activeCalls.get(chatId)
    try {
      await call.end()
    } catch (e) {
      console.error('[ VOIP ] call.end() threw:', e?.message || e)
    } finally {
      call.removeAllListeners?.()
      activeCalls.delete(chatId)
      cleanup()
    }
    conn.sendMessage(m.chat, { text: `✦ Call ended for ${phoneNumber}`, edit: key })
    return
  }

  // Handle voipcall
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [audio_url] (reply to an audio file or provide URL)`
  if (busy) throw 'A call is already in progress, wait for it to finish.'

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  let audioSource = 'silence'
  let audioUrl = args[1]
  let isTempFile = false
  
  if (audioUrl && isValidUrl(audioUrl)) {
    try {
      await m.reply('✦ Downloading audio from URL...')
      audioSource = await downloadAudioFromUrl(audioUrl)
      isTempFile = true
      console.log('[ VOIP ] Audio downloaded from URL:', audioUrl)
    } catch (e) {
      throw `Failed to download audio from URL: ${e.message}`
    }
  } else if (m.quoted) {
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

  busy = true
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    busy = false
    if (safetyTimer) clearTimeout(safetyTimer)
    resetClient()
    if (isTempFile && audioSource !== 'silence' && fs.existsSync(audioSource)) {
      fs.unlink(audioSource, () => {})
    }
  }

  // Safety-net: if for any reason 'ended'/'error' never fires (signaling
  // hangs silently, WASM never emits a final state, etc.), force-reset busy
  // after a hard cap so the command doesn't stay stuck forever. WhatsApp's
  // own ringing timeout is usually well under a minute, so 90s is generous
  // enough to not cut a legitimately-connecting call short.
  const safetyTimer = setTimeout(() => {
    if (!cleaned) {
      console.warn('[ VOIP ] Safety timeout hit — forcing cleanup, call never reached ended/error.')
      cleanup()
    }
  }, 90_000)

  try {
    const client = await getClient(conn)
    console.log('[ VOIP ] dialing', phoneNumber)

    if (audioSource !== 'silence' && !fs.existsSync(audioSource)) {
      throw new Error(`Audio file not found: ${audioSource}`)
    }

    const { key } = await m.reply(`✦ Calling ${phoneNumber}... (Use .voipend to end call)`)

    console.log('[ VOIP ] Audio source:', audioSource)

    let durationMs
    if (audioSource !== 'silence') {
      durationMs = await getAudioDurationMs(audioSource)
      if (durationMs) {
        console.log('[ VOIP ] Detected audio duration (ms):', durationMs)
      } else {
        console.log('[ VOIP ] Could not detect audio duration, call will not auto-hangup')
      }
    }

    const call = await client.call(phoneNumber, { audioSource, ...(durationMs ? { durationMs } : {}) })

    // Store active call
    activeCalls.set(m.chat, { call, key, phoneNumber, cleanup })

    call.on('ringing', () => {
      console.log('[ VOIP ] event: ringing')
      conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
    })
    call.on('connected', () => {
      console.log('[ VOIP ] event: connected')
      conn.sendMessage(m.chat, { text: `✦ Call connected! Use .voipend to end.`, edit: key })
    })
    call.on('ended', (reason) => {
      console.log('[ VOIP ] event: ended, reason=', reason)
      conn.sendMessage(m.chat, { text: `✦ Call ended: ${reason}`, edit: key })
      call.removeAllListeners?.()
      activeCalls.delete(m.chat)
      cleanup()
    })
    call.on('error', (err) => {
      console.error('[ VOIP ] event: error', err)
      conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
      call.removeAllListeners?.()
      activeCalls.delete(m.chat)
      cleanup()
    })
  } catch (e) {
    console.error('[ VOIP ] call() threw before/during setup:', e)
    activeCalls.delete(m.chat)
    cleanup()
    throw e
  }
}

handler.help = ['voipcall <number> [audio_url] (reply to audio or provide URL)', 'voipend']
handler.tags = ['owner']
handler.command = /^(voipcall|voipend)$/i
handler.rowner = true

export default handler