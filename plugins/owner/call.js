import path from 'path'
import fs from 'fs'
import { voipPair } from '../../lib/simple.js'

let activeCalls = new Map() // chatId -> { call, key, phoneNumber }

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (command === 'voippair') {
    if (args[0] === 'force') {
      const authDir = path.join(process.cwd(), 'data/sessions/caller')
      try { fs.rmSync(authDir, { recursive: true, force: true }) } catch {}
      return void (await m.reply('✦ VOIP session cleared. Run `.voippair` again to re-link.'))
    }

    const { key } = await m.reply('✦ Starting VOIP device pairing...')
    try {
      const result = await voipPair(conn, process.env.CUSTOM_PAIRING || undefined)
      if (result.alreadyLinked) {
        return void conn.sendMessage(m.chat, { text: '✦ VOIP device was already linked. Use `.voippair force` to re-link.', edit: key })
      }
      conn.sendMessage(m.chat, { text: '✦ VOIP device linked successfully! You can now use .voipcall.', edit: key })
    } catch (e) {
      conn.sendMessage(m.chat, { text: `❌ Pairing failed: ${e?.message || e}`, edit: key })
    }
    return
  }

  if (command === 'voipend') {
    if (args[0] === 'force' || !activeCalls.has(m.chat)) {
      await conn.callEnd(true)
      activeCalls.clear()
      return void (await m.reply('✦ VOIP state force-reset.'))
    }
    await conn.callEnd()
    return void (await m.reply('✦ Hangup requested...'))
  }

  // .voipcall
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [audio_url] (reply to an audio file or provide URL) [video]`
  if (activeCalls.has(m.chat)) throw 'A call is already in progress in this chat, wait for it to finish (or `.voipend`).'

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|avi|m4v)(\?|$)/i

  const explicitVideoFlag = args.includes('video')
  const url = args.find((a, i) => i > 0 && /^https?:\/\//i.test(a))
  const urlIsVideo = url ? VIDEO_EXT_RE.test(url) : false

  let audioSource = 'silence'
  let videoSource = null
  let isTempFile = false

  if (url && urlIsVideo) {
    videoSource = url
  } else if (url) {
    audioSource = url
  } else if (m.quoted) {
    const mime = m.quoted.mimetype || ''
    if (/^video/.test(mime)) {
      const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp')
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
      const buffer = await m.quoted?.download()
      if (!buffer) throw 'Failed to download the replied video.'
      videoSource = path.join(tmpDir, `voipvideo_${Date.now()}.mp4`)
      fs.writeFileSync(videoSource, buffer)
      isTempFile = true
    } else if (/^audio/.test(mime)) {
      const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp')
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
      const buffer = await m.quoted?.download()
      if (!buffer) throw 'Failed to download the replied audio.'
      audioSource = path.join(tmpDir, `voip_${Date.now()}.audio`)
      fs.writeFileSync(audioSource, buffer)
      isTempFile = true
    }
  }

  const isVideo = explicitVideoFlag || !!videoSource

  const { key } = await m.reply(`✦ Calling ${phoneNumber}...${isVideo ? ' (video)' : ''} (Use .voipend to end call)`)

  try {
    const call = await conn.call(phoneNumber, audioSource, { isVideo, videoSource })
    activeCalls.set(m.chat, { call, key, phoneNumber })

    call.on('ringing', () => {
      conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
    })
    call.on('connected', () => {
      conn.sendMessage(m.chat, { text: '✦ Call connected! Use .voipend to end.', edit: key })
    })
    call.on('ended', (reason) => {
      activeCalls.delete(m.chat)
      const friendlyText = reason === 'declined'
        ? `✦ Call to ${phoneNumber} was declined.`
        : `✦ Call ended for ${phoneNumber}: ${reason}`
      conn.sendMessage(m.chat, { text: friendlyText, edit: key })
      if (isTempFile) {
        if (audioSource !== 'silence' && fs.existsSync(audioSource)) fs.unlink(audioSource, () => {})
        if (videoSource && fs.existsSync(videoSource)) fs.unlink(videoSource, () => {})
      }
    })
    call.on('error', (err) => {
      activeCalls.delete(m.chat)
      conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
      if (isTempFile) {
        if (audioSource !== 'silence' && fs.existsSync(audioSource)) fs.unlink(audioSource, () => {})
        if (videoSource && fs.existsSync(videoSource)) fs.unlink(videoSource, () => {})
      }
    })
  } catch (e) {
    console.error('[ VOIP ] conn.call() threw:', e)
    activeCalls.delete(m.chat)
    if (isTempFile) {
      if (audioSource !== 'silence' && fs.existsSync(audioSource)) fs.unlink(audioSource, () => {})
      if (videoSource && fs.existsSync(videoSource)) fs.unlink(videoSource, () => {})
    }
    throw `Failed to place call: ${e?.message || e}`
  }
}

handler.help = ['voippair (one-time device setup)', 'voipcall <number> [audio_url|video_url] [video] (reply to audio/video or provide URL)', 'voipend']
handler.tags = ['owner']
handler.command = /^(voippair|voipcall|voipend)$/i
handler.rowner = true

export default handler
