import path from 'path'
import fs from 'fs'
import { voipPair } from '../../lib/utils/simple.js'

let activeCalls = new Map() // chatId -> { call, key, phoneNumber }

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (command === 'voippair') {
    if (args[0] === 'force') {
      const authDbFile = path.join(process.cwd(), global.settings.connection.caller.file)
      try { fs.rmSync(authDbFile, { force: true }) } catch {}
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
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number> [audio_url] [video_url] (reply to audio/video or provide URL(s))`
  if (activeCalls.has(m.chat)) throw 'A call is already in progress in this chat, wait for it to finish (or `.voipend`).'

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  const isVideoFlag = args.includes('video')
  const urls = args.filter((a, i) => i > 0 && /^https?:\/\//i.test(a))
  // A URL ending in a known video extension is treated as the video source
  // automatically — no need to also type "video" as a separate arg for the
  // common case of just pasting an mp4 link.
  const videoUrl = urls.find((u) => /\.(mp4|mov|webm|mkv|avi)(\?|$)/i.test(u))
  const audioUrl = urls.find((u) => u !== videoUrl)

  let audioSource = audioUrl || 'silence'
  let videoSource = videoUrl || null
  let isTempAudioFile = false
  let isTempVideoFile = false

  if (m.quoted) {
    const mime = m.quoted.mimetype || ''
    const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
    if (!videoSource && /^video/.test(mime)) {
      const buffer = await m.quoted?.download()
      if (!buffer) throw 'Failed to download the replied video.'
      videoSource = path.join(tmpDir, `voipvideo_${Date.now()}.mp4`)
      fs.writeFileSync(videoSource, buffer)
      isTempVideoFile = true
      // The replied video's own audio track becomes the call's audio unless
      // the caller separately supplied an audio URL — without this,
      // audioSource stays 'silence' even though the video has sound,
      // because AudioFeeder and VideoFeeder are fed independently and
      // nothing here previously connected the two.
      if (!audioUrl) {
        audioSource = videoSource
      }
    } else if (!audioUrl && /^audio/.test(mime)) {
      const buffer = await m.quoted?.download()
      if (!buffer) throw 'Failed to download the replied audio.'
      audioSource = path.join(tmpDir, `voip_${Date.now()}.audio`)
      fs.writeFileSync(audioSource, buffer)
      isTempAudioFile = true
    }
  }

  const isVideo = isVideoFlag || !!videoSource

  const { key } = await m.reply(`✦ Calling ${phoneNumber}...${isVideo ? ' (video)' : ''} (Use .voipend to end call)`)

  const cleanupTempFiles = () => {
    if (isTempAudioFile && fs.existsSync(audioSource)) fs.unlink(audioSource, () => {})
    if (isTempVideoFile && videoSource && fs.existsSync(videoSource)) fs.unlink(videoSource, () => {})
  }

  try {
    const call = await conn.call(phoneNumber, audioSource, { isVideo, ...(videoSource ? { videoSource } : {}) })
    activeCalls.set(m.chat, { call, key, phoneNumber })

    call.on('ringing', () => {
      conn.sendMessage(m.chat, { text: `✦ Ringing ${phoneNumber}...`, edit: key })
    })
    call.on('connected', () => {
      conn.sendMessage(m.chat, { text: '✦ Call connected! Use .voipend to end.', edit: key })
    })
    // DIAGNOSTIC: prints any call-related event WhatsApp's native stack
    // reports that this bot doesn't otherwise recognize — this is where
    // "someone else in the call added a new participant" is expected to
    // show up while testing, since there's no dedicated
    // 'participantJoined' event wired up yet (see lib/package/voip/index.js
    // #handleCallEvent and lib/package/voip/modules/signaling.js). Once a real
    // add-by-someone-else is captured here, its eventType/tag can be
    // promoted to a proper named event instead of this raw dump.
    call.on('unknownCallEvent', ({ eventType, eventData }) => {
      const preview = JSON.stringify(eventData)
      conn.sendMessage(m.chat, { text: `🔍 [diag] call event ${eventType}: ${preview?.slice(0, 500) ?? 'null'}` })
    })
    call.on('ended', (reason) => {
      activeCalls.delete(m.chat)
      const friendlyText = reason === 'declined'
        ? `✦ Call to ${phoneNumber} was declined.`
        : `✦ Call ended for ${phoneNumber}: ${reason}`
      conn.sendMessage(m.chat, { text: friendlyText, edit: key })
      cleanupTempFiles()
    })
    call.on('error', (err) => {
      activeCalls.delete(m.chat)
      conn.reply(m.chat, `Call error: ${err?.message || err}`, m)
      cleanupTempFiles()
    })
  } catch (e) {
    console.error('[ VOIP ] conn.call() threw:', e)
    activeCalls.delete(m.chat)
    cleanupTempFiles()
    throw `Failed to place call: ${e?.message || e}`
  }
}

handler.help = ['voippair (one-time device setup)', 'voipcall <number> [audio_url] [video_url] [video] (reply to audio/video or provide URL(s))', 'voipend']
handler.tags = ['owner']
handler.command = /^(voippair|voipcall|voipend)$/i
handler.rowner = true

export default handler
