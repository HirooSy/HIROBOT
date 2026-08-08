import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import loadVoip from '../../lib/voip/voip.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP_DIR = path.join(__dirname, '..', '..', 'tmp')

let sharedClient = null
let connecting = null

async function getClient(conn) {
  if (sharedClient) return sharedClient
  if (connecting) return connecting

  connecting = (async () => {
    const { VoipClient } = await loadVoip()
    // Reuses the bot's already-authenticated socket — no separate QR/link step needed.
    const client = new VoipClient({ existingSocket: conn })
    await client.connect()
    sharedClient = client
    return client
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [reply to audio, or leave blank for silence]`

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  const durationMs = parseInt(args[1]) > 0 ? parseInt(args[1]) * 1000 : 60_000

  let audioSource = 'silence'
  const quoted = m.quoted ? m.quoted : m
  const mime = (quoted.msg || quoted).mimetype || ''

  if (/audio/.test(mime)) {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
    const buffer = await quoted.download()
    audioSource = path.join(TMP_DIR, `voip_${Date.now()}.audio`)
    fs.writeFileSync(audioSource, buffer)
  }

  const client = await getClient(conn)

  const { key } = await m.reply(`✦ Calling ${phoneNumber}...`)

  const call = await client.call(phoneNumber, { audioSource, durationMs })

  call.on('ringing', () => conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key }))
  call.on('connected', () => conn.sendMessage(m.chat, { text: `✦ Call connected. Auto-hangup in ${durationMs / 1000}s.`, edit: key }))
  call.on('ended', (reason) => {
    conn.sendMessage(m.chat, { text: `✦ Call ended: ${reason}`, edit: key })
    if (audioSource !== 'silence') fs.unlink(audioSource, () => {})
  })
  call.on('error', (err) => conn.reply(m.chat, `Call error: ${err?.message || err}`, m))
}

handler.help = ['call <number> [duration_seconds]']
handler.tags = ['owner']
handler.command = /^(call|voipcall)$/i
handler.rowner = true

export default handler
