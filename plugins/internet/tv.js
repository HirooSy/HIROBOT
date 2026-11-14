import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const tv = {
  defaultResolution: '720p',
  maxResolution: 1080,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
  categoryTitleLength: 24,
  pageSize: 1000,
  cardsPerMessage: 11,
  messageBytes: 400000,
  writerRetryLimit: 5,
  writerRetryDelayMs: 2000,
  pipeReleaseDelayMs: 1000,
  regionNames: new Intl.DisplayNames(['en'], { type: 'region' }),
  sessions: global.waTvSessions ||= new Map()
}

async function withSource(task) {
  const source = global.scraper?.tv
  if (typeof source?.loadChannels !== 'function') throw 'TV source is not available.'
  try {
    return await task(source)
  } catch (err) {
    throw err?.message || String(err)
  }
}

function countryName(code) {
  if (!code || code === 'xx') return 'Other'
  const upper = code.toUpperCase()
  try {
    return tv.regionNames.of(upper) || upper
  } catch {
    return upper
  }
}

function parseListArgs(args) {
  return String(args || '').trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

function listEntries(channels, filter) {
  const matches = entry => {
    if (!filter) return true
    if (filter.length === 2) return entry.channel.country === filter
    return entry.country.toLowerCase().includes(filter)
  }
  return channels
    .map((channel, index) => ({ channel, index, country: countryName(channel.country) }))
    .filter(matches)
    .sort((a, b) => a.country.localeCompare(b.country) || a.channel.name.localeCompare(b.channel.name))
}

function channelQuality(channel) {
  if (/^https?:\/\//i.test(channel.name || '')) return tv.defaultResolution
  const match = /\b(\d{3,4})p\b/i.exec(channel.name || '')
  if (!match) return tv.defaultResolution
  return `${Math.min(Number(match[1]), tv.maxResolution)}p`
}

function videoConfigOf(quality) {
  const height = parseInt(quality, 10)
  return { width: Math.round((height * 16) / 9 / 2) * 2, height, frameRate: 30 }
}

function cardBytes(card) {
  return card.nativeFlow.reduce((total, button) => total
    + Buffer.byteLength(button.text)
    + button.sections.reduce((sum, section) => sum + section.rows.reduce((rows, row) => rows
      + Buffer.byteLength(row.header) + Buffer.byteLength(row.title) + Buffer.byteLength(row.id), 0), 0), 0)
}

function groupEntries(entries) {
  const groups = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last?.title === entry.country) last.items.push(entry)
    else groups.push({ title: entry.country, items: [entry] })
  }
  return groups
}

async function sendChannelList(m, { conn, usedPrefix }, args) {
  const filter = parseListArgs(args)
  const { channels, version } = await withSource(async source => ({
    channels: await source.loadChannels(),
    version: source.channelVersion()
  }))
  const entries = listEntries(channels, filter)
  if (!entries.length) throw 'No channels found for that filter.'

  const cards = []
  for (let start = 0; start < entries.length; start += tv.pageSize) {
    const slice = entries.slice(start, start + tv.pageSize)
    cards.push({
      image: global.img?.profile?.bot,
      text: `${start + 1}-${start + slice.length} of ${entries.length} channel(s)`,
      optionText: 'Select',
      optionTitle: 'Select',
      nativeFlow: groupEntries(slice).map(group => ({
        text: group.title.slice(0, tv.categoryTitleLength),
        sections: [{
          rows: group.items.map(({ channel, index }) => ({
            header: channel.name,
            title: `Watch live in ${channelQuality(channel)}`,
            id: `${usedPrefix}tvpick ${version} ${index}`
          }))
        }]
      }))
    })
  }

  const batches = []
  let batch = []
  let batchBytes = 0
  for (const card of cards) {
    const bytes = cardBytes(card)
    if (batch.length && (batch.length === tv.cardsPerMessage || batchBytes + bytes > tv.messageBytes)) {
      batches.push(batch)
      batch = []
      batchBytes = 0
    }
    batch.push(card)
    batchBytes += bytes
  }
  if (batch.length) batches.push(batch)

  const header = `*TV Channels*\n- Country: ${filter || 'All'}\n- Total: ${entries.length} channel(s)\n\nSelect a country, then a channel to watch it live in its own resolution.`
  for (const [index, group] of batches.entries()) {
    await conn.sendButton(m.chat, {
      text: index ? '*TV Channels* (continued)' : header,
      cards: group
    }, m)
  }
}

async function voipOf(conn) {
  if (!conn.voipInstance) {
    const { default: Voip } = await import('hiro/voip')
    conn.voipInstance ||= new Voip(conn, { voipLogLevel: 'warn' })
  }
  return conn.voipInstance
}

function openPipe() {
  const fifo = path.join(os.tmpdir(), `hiro-tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.fifo`)
  const made = spawnSync('mkfifo', [fifo], { stdio: 'ignore' })
  if (made.status !== 0) throw new Error('mkfifo is required for TV streaming')
  const holder = fs.openSync(fifo, 'r+')
  return { fifo, holder, writer: null }
}

function killWriter(pipe) {
  const proc = pipe?.writer
  if (!proc) return
  pipe.writer = null
  try {
    proc.kill('SIGKILL')
  } catch {}
}

function closePipe(pipe) {
  killWriter(pipe)
  try {
    fs.closeSync(pipe.holder)
  } catch {}
  fs.rm(pipe.fifo, { force: true }, () => {})
}

function sendNote(session, text) {
  session.conn.sendMessage(session.chat, { text }).catch(() => {})
}

function liveStartArgs(url) {
  return /\.m3u8/i.test(url) ? ['-live_start_index', '-1'] : []
}

function spawnWriter(session, pipe, url) {
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-user_agent', tv.userAgent,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...liveStartArgs(url),
    '-i', url,
    '-an', '-sn', '-dn', '-c:v', 'copy',
    '-f', 'mpegts', pipe.fifo
  ], { stdio: 'ignore' })
  pipe.writer = proc
  const exited = () => {
    if (pipe.writer !== proc) return
    pipe.writer = null
    if (session.closed || session.pipe !== pipe) return
    session.writerRetries += 1
    if (session.writerRetries > tv.writerRetryLimit) {
      sendNote(session, 'The channel stream stopped. Send .tv and pick another channel.')
      return
    }
    setTimeout(() => {
      if (!session.closed && session.pipe === pipe && !pipe.writer) spawnWriter(session, pipe, url)
    }, tv.writerRetryDelayMs).unref?.()
  }
  proc.on('close', exited)
  proc.on('error', exited)
  return proc
}

function startWriter(session) {
  const pipe = session.pipe
  if (!pipe || pipe.writer || session.closed) return
  spawnWriter(session, pipe, session.channel.url)
}

function tvStatusLabel(session) {
  if (session.phase === 'closed') return `Ended (${session.endReason})`
  if (session.phase === 'reconnecting') return session.reconnect?.attempt ? `Reconnecting (${session.reconnect.attempt}/${session.reconnect.max})...` : 'Reconnecting...'
  if (session.phase === 'playing') return 'Live'
  return session.phase === 'ringing' ? 'Ringing...' : 'Calling...'
}

function tvStatusText(session) {
  return [
    `📺 *${session.channel.name}*`,
    `Quality: ${session.quality}`,
    `Status: ${tvStatusLabel(session)}`
  ].join('\n')
}

async function editTvStatus(session) {
  if (!session.statusKey) return
  try {
    await session.conn.sendMessage(session.chat, { text: tvStatusText(session), edit: session.statusKey })
  } catch {
    const sent = await session.conn.sendMessage(session.chat, { text: tvStatusText(session) })
    session.statusKey = sent?.key || session.statusKey
  }
}

function refreshTvStatus(session) {
  session.editChain = session.editChain.then(() => editTvStatus(session)).catch(() => {})
}

function releaseRetired(session) {
  const keep = []
  for (const pipe of session.retired) {
    if (pipe.fifo === session.loadedFifo) keep.push(pipe)
    else closePipe(pipe)
  }
  session.retired = keep
}

function releasePipes(session) {
  const pipes = [...session.retired, session.pipe].filter(Boolean)
  session.retired = []
  session.pipe = null
  for (const pipe of pipes) closePipe(pipe)
}

function finishTvSession(session, reason) {
  if (tv.sessions.get(session.chat) !== session) return
  tv.sessions.delete(session.chat)
  session.closed = true
  for (const [event, listener] of session.listeners) session.coordinator.off(event, listener)
  session.listeners = []
  session.phase = 'closed'
  session.endReason = session.endReason || String(reason || 'ended')
  refreshTvStatus(session)
  setTimeout(() => releasePipes(session), tv.pipeReleaseDelayMs).unref?.()
}

function bindCallEvents(session) {
  const { coordinator, callId } = session
  const on = (event, listener) => {
    coordinator.on(event, listener)
    session.listeners.push([event, listener])
  }

  on('call_state', info => {
    if (info?.callId !== callId || session.closed) return
    if (info.isRinging && session.phase === 'calling') {
      session.phase = 'ringing'
      refreshTvStatus(session)
    }
    if (info.isActive && !session.connected) {
      session.connected = true
      session.phase = 'playing'
      session.writerRetries = 0
      startWriter(session)
      refreshTvStatus(session)
    }
  })
  on('call_ended', info => {
    if (info?.callId === callId) finishTvSession(session, info?.stateData?.endReason)
  })
  on('call_error', err => {
    if (session.closed || (err?.callId && err.callId !== callId)) return
    sendNote(session, `TV error: ${err?.message || err}`)
  })
  on('call_reconnecting', (info, detail) => {
    if (info?.callId !== callId || session.closed) return
    if (session.phase !== 'reconnecting') session.resumePhase = session.phase
    session.phase = 'reconnecting'
    session.reconnect = detail
    refreshTvStatus(session)
  })
  on('call_reconnected', info => {
    if (info?.callId !== callId || session.closed || session.phase !== 'reconnecting') return
    session.phase = session.resumePhase || 'playing'
    session.resumePhase = null
    session.reconnect = null
    refreshTvStatus(session)
  })
}

async function startTvSession(m, { conn }, channel) {
  const voip = await voipOf(conn)
  try {
    await voip.listen()
  } catch (err) {
    throw `Failed to connect to the calling service: ${err?.message || err}`
  }
  const coordinator = voip.coordinator
  if (!coordinator) throw 'The calling service is not ready yet.'

  const quality = channelQuality(channel)
  let callId
  try {
    callId = await coordinator.startCall({ peerJid: m.sender, isVideo: true, videoConfig: videoConfigOf(quality) })
  } catch (err) {
    throw `Failed to place call: ${err?.message || err}`
  }

  const session = {
    conn,
    chat: m.chat,
    requester: m.sender,
    coordinator,
    callId,
    channel,
    quality,
    pipe: null,
    loadedFifo: null,
    retired: [],
    phase: 'calling',
    connected: false,
    closed: false,
    writerRetries: 0,
    editChain: Promise.resolve(),
    statusKey: null,
    reconnect: null,
    resumePhase: null,
    endReason: '',
    listeners: []
  }
  bindCallEvents(session)
  tv.sessions.set(m.chat, session)

  try {
    session.pipe = openPipe()
    await coordinator.loadAudio(callId, channel.url)
    await coordinator.loadVideo(callId, session.pipe.fifo)
    session.loadedFifo = session.pipe.fifo
    if (session.connected) startWriter(session)
  } catch (err) {
    coordinator.endCall(callId).catch(() => {})
    finishTvSession(session, 'failed')
    throw `Failed to start the stream: ${err?.message || err}`
  }

  if (session.closed) throw 'The call ended before it started.'
  try {
    const sent = await conn.sendMessage(m.chat, { text: tvStatusText(session) }, { quoted: m })
    session.statusKey = sent?.key || null
  } catch (err) {
    coordinator.endCall(callId).catch(() => {})
    finishTvSession(session, 'failed')
    throw `Failed to send the TV status: ${err?.message || err}`
  }
  refreshTvStatus(session)
}

async function switchVideo(session) {
  if (session.loadedFifo !== session.pipe.fifo) {
    try {
      await session.coordinator.swapVideoSource(session.callId, session.pipe.fifo)
    } catch (err) {
      sendNote(session, `TV error: ${err?.message || err}`)
      return
    }
    session.loadedFifo = session.pipe.fifo
  }
  releaseRetired(session)
}

async function tuneSession(session, channel) {
  if (!session.connected) throw 'Wait until the call is connected.'
  if (session.channel.url === channel.url) throw `${channel.name} is already playing.`

  const previous = session.pipe
  const next = openPipe()
  try {
    await session.coordinator.loadAudio(session.callId, channel.url)
  } catch (err) {
    closePipe(next)
    throw `Failed to switch the channel: ${err?.message || err}`
  }

  killWriter(previous)
  if (previous) session.retired.push(previous)
  session.pipe = next
  session.channel = channel
  session.writerRetries = 0
  spawnWriter(session, next, channel.url)
  await switchVideo(session)
  refreshTvStatus(session)
}

async function restartTvSession(m, extra, session, channel) {
  if (!session.connected) throw 'Wait until the call is connected.'
  session.endReason = 'switched'
  await session.coordinator.endCall(session.callId).catch(() => {})
  finishTvSession(session, 'switched')
  return startTvSession(m, extra, channel)
}

async function playChannel(m, { conn, isOwner }, channel) {
  const session = tv.sessions.get(m.chat)
  if (session && session.requester !== m.sender && !isOwner) throw 'Only the person who started the TV can change the channel.'

  await m.react('📺')
  const reachable = await withSource(source => source.probeStream(channel.url))
  if (!reachable) throw `${channel.name} is not reachable right now.`

  if (!session) return startTvSession(m, { conn }, channel)
  if (session.quality !== channelQuality(channel)) return restartTvSession(m, { conn }, session, channel)
  return tuneSession(session, channel)
}

async function tvPlay(m, extra) {
  const { conn, text, usedPrefix, isOwner } = extra
  const query = String(text || '').trim()
  if (!query) return sendChannelList(m, { conn, usedPrefix }, '')

  const [first, ...rest] = query.split(/\s+/)
  if (first.toLowerCase() === 'list') return sendChannelList(m, { conn, usedPrefix }, rest.join(' '))

  const channel = await withSource(source => source.resolveChannel(query))
  return playChannel(m, { conn, isOwner }, channel)
}

async function tvPick(m, extra) {
  const { conn, text, isOwner } = extra
  const [version, index] = String(text || '').trim().split(/\s+/)
  const channel = await withSource(source => source.pickChannel(version, index))
  return playChannel(m, { conn, isOwner }, channel)
}

export default [
  Object.assign((m, extra) => tvPlay(m, extra), {
    command: ['tv'],
    description: 'Browse live TV channels by country or watch one in a video call at its own resolution',
    help: ['tv', 'tv list [country]', 'tv <channel name or stream url>'],
    tags: ['internet'],
    ai: { risk: 'low', description: 'browse and watch live TV channels in a WhatsApp video call' },
    platform: { whatsapp: true, discord: false }
  }),
  Object.assign((m, extra) => tvPick(m, extra), {
    command: ['tvpick'],
    tags: ['internet'],
    help: [],
    hidden: true,
    platform: { whatsapp: true, discord: false }
  })
]
