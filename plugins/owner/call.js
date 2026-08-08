import path from 'path'
import fs from 'fs'
import axios from 'axios'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, '..', '..', 'lib', 'voip', 'call-worker.js')
const AUTH_DIR = 'data/sessions/caller'

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

const TMP_DIR = path.join(process.cwd(), process.env.TMP || 'data/tmp')

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

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
    url,
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
  try { new URL(string); return true } catch { return false }
}

// Tracks the single in-flight call: child process handle + chat context.
let active = null // { proc, chatId, key, phoneNumber, isTempFile, audioSource, cleaned }

function cleanup() {
  if (!active || active.cleaned) return
  active.cleaned = true
  if (active.isTempFile && active.audioSource !== 'silence' && fs.existsSync(active.audioSource)) {
    fs.unlink(active.audioSource, () => {})
  }
  if (active.proc && !active.proc.killed) {
    try { active.proc.kill() } catch {}
  }
  active = null
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (command === 'voippair') {
    if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      return void (await m.reply('✦ VOIP device is already linked. Delete the `data/sessions/caller` folder first if you want to re-pair.'))
    }
    if (active) throw 'A VOIP operation is already in progress, wait for it to finish.'

    const pairingNumber = (conn.user?.id || '').split(':')[0].split('@')[0]
    const customPairingCode = process.env.CUSTOM_PAIRING || undefined

    const { key } = await m.reply('✦ Starting VOIP device pairing...')

    const proc = fork(WORKER_PATH, [], {
      env: {
        ...process.env,
        VOIP_AUTH_DIR: AUTH_DIR,
        VOIP_CALL_PARAMS: JSON.stringify({ mode: 'pair', pairingNumber, customPairingCode })
      }
    })

    active = { proc, chatId: m.chat, key, phoneNumber: null, isTempFile: false, audioSource: 'silence', cleaned: false }

    proc.on('message', (msg) => {
      switch (msg.type) {
        case 'pairing_needed': {
          const codeNote = msg.customPairingCode ? `custom code *${msg.customPairingCode.toUpperCase()}*` : 'an 8-digit pairing code'
          conn.sendMessage(m.chat, { text: `✦ Check the server console for ${codeNote}, then enter it in WhatsApp > Linked Devices > Link with phone number. You have about 2 minutes.`, edit: key })
          break
        }
        case 'already_linked':
          conn.sendMessage(m.chat, { text: '✦ VOIP device was already linked.', edit: key })
          cleanup()
          break
        case 'paired':
          conn.sendMessage(m.chat, { text: '✦ VOIP device linked successfully! You can now use .voipcall.', edit: key })
          cleanup()
          break
        case 'error':
          console.error('[ VOIP ] pairing error:', msg.message)
          conn.sendMessage(m.chat, { text: `❌ Pairing failed: ${msg.message}`, edit: key })
          cleanup()
          break
      }
    })

    proc.on('exit', () => { if (active?.proc === proc) cleanup() })
    proc.on('error', (err) => {
      console.error('[ VOIP ] pairing worker spawn error:', err)
      conn.reply(m.chat, `Failed to start VOIP pairing: ${err.message}`, m)
      cleanup()
    })
    return
  }

  if (command === 'voipend') {
    if (args[0] === 'force' || !active) {
      cleanup()
      return void (await m.reply(active === null ? '✦ VOIP state force-reset.' : '❌ No active call.'))
    }
    active.proc.send({ type: 'hangup' })
    return void (await m.reply(`✦ Hangup requested for ${active.phoneNumber}...`))
  }

  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [audio_url] (reply to an audio file or provide URL)`
  if (active) throw 'A call is already in progress, wait for it to finish (or `.voipend`).'

  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    throw 'VOIP device not linked yet. Run `.voippair` first (one-time setup).'
  }

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  let audioSource = 'silence'
  let audioUrl = args[1]
  let isTempFile = false

  if (audioUrl && isValidUrl(audioUrl)) {
    await m.reply('✦ Downloading audio from URL...')
    audioSource = await downloadAudioFromUrl(audioUrl)
    isTempFile = true
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

  let durationMs
  if (audioSource !== 'silence') {
    durationMs = await getAudioDurationMs(audioSource)
  }

  const { key } = await m.reply(`✦ Calling ${phoneNumber}... (Use .voipend to end call)`)

  const proc = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      VOIP_AUTH_DIR: AUTH_DIR,
      VOIP_CALL_PARAMS: JSON.stringify({ mode: 'call', phoneNumber, audioSource, durationMs })
    }
  })

  active = { proc, chatId: m.chat, key, phoneNumber, isTempFile, audioSource, cleaned: false }

  proc.on('message', (msg) => {
    switch (msg.type) {
      case 'connected':
        console.log('[ VOIP ] worker connected')
        break
      case 'ringing':
        conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
        break
      case 'call_connected':
        conn.sendMessage(m.chat, { text: `✦ Call connected! Use .voipend to end.`, edit: key })
        break
      case 'ended':
        conn.sendMessage(m.chat, { text: `✦ Call ended: ${msg.reason}`, edit: key })
        cleanup()
        break
      case 'error':
        console.error('[ VOIP ] worker error:', msg.message)
        conn.reply(m.chat, `Call error: ${msg.message}`, m)
        cleanup()
        break
    }
  })

  proc.on('exit', (code) => {
    console.log('[ VOIP ] worker process exited, code=', code)
    if (active?.proc === proc) cleanup()
  })

  proc.on('error', (err) => {
    console.error('[ VOIP ] worker spawn error:', err)
    conn.reply(m.chat, `Failed to start VOIP worker: ${err.message}`, m)
    cleanup()
  })
}

handler.help = ['voippair (one-time device setup)', 'voipcall <number> [audio_url] (reply to audio or provide URL)', 'voipend']
handler.tags = ['owner']
handler.command = /^(voippair|voipcall|voipend)$/i
handler.rowner = true

export default handler