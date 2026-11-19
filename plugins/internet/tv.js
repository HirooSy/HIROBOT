import net from 'net'
import { spawn } from 'child_process'

const tv = {
  defaultResolution: '720p',
  maxResolution: 1080,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
  titleLength: 24,
  joinWaitMs: 10 * 60_000,
  writerRetryLimit: 5,
  writerRetryDelayMs: 2000,
  pipeReleaseDelayMs: 1000,
  relayBufferBytes: 4 * 1024 * 1024,
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

function countryCode(channel) {
  return String(channel.country || 'xx').toLowerCase()
}

function countryRows(channels) {
  const totals = new Map()
  for (const channel of channels) totals.set(countryCode(channel), (totals.get(countryCode(channel)) || 0) + 1)
  return [...totals]
    .map(([code, total]) => ({ code, name: countryName(code), total }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

function isCountryQuery(channels, query) {
  return channels.some(channel => countryCode(channel) === query || countryName(countryCode(channel)).toLowerCase() === query)
}

function exactCountryEntries(channels, query) {
  return listEntries(channels, '').filter(({ channel, country }) => countryCode(channel) === query || country.toLowerCase() === query)
}

async function loadCatalog() {
  return withSource(async source => ({ channels: await source.loadChannels(), version: source.channelVersion() }))
}

async function sendSelect(conn, m, { heading, detail, buttonText, sectionTitle, rows }) {
  await conn.sendButton(m.chat, {
    text: `*${heading}*\n${detail}`,
    nativeFlow: [{ text: buttonText, sections: [{ title: sectionTitle, rows }] }]
  }, m)
}

async function sendCountryList(m, { conn, usedPrefix }) {
  const { channels } = await loadCatalog()
  const countries = countryRows(channels)
  if (!countries.length) throw 'No channels found.'
  await sendSelect(conn, m, {
    heading: 'TV Countries',
    detail: `- Total: ${countries.length} country(ies)\n\nSelect a country to see its channels.`,
    buttonText: 'Select country',
    sectionTitle: 'Countries',
    rows: countries.map(country => ({
      header: country.name,
      title: country.name.slice(0, tv.titleLength),
      description: `${country.total} channel(s)`,
      id: `${usedPrefix}tv ${country.code}`
    }))
  })
}

async function sendChannelSelect(m, { conn, usedPrefix }, entries, version, heading) {
  if (!entries.length) throw 'No channels found for that filter.'
  const countries = [...new Set(entries.map(entry => entry.country))]
  await sendSelect(conn, m, {
    heading,
    detail: `- Total: ${entries.length} channel(s)\n\nSelect a channel to watch it live in its own resolution.`,
    buttonText: 'Select channel',
    sectionTitle: (countries.length === 1 ? countries[0] : 'Channels').slice(0, tv.titleLength),
    rows: entries.map(({ channel, index }) => ({
      header: String(channel.name || ''),
      title: String(channel.name || '').slice(0, tv.titleLength),
      description: `Watch live in ${channelQuality(channel)}`,
      id: `${usedPrefix}tvpick ${version} ${index}`
    }))
  })
}

async function voipOf(conn) {
  if (!conn.voipInstance) {
    const { default: Voip } = await import('hiro/voip')
    conn.voipInstance ||= new Voip(conn, { voipLogLevel: 'warn' })
  }
  return conn.voipInstance
}

function openPipe() {
  return new Promise((resolve, reject) => {
    const pipe = { server: null, socket: null, writer: null, source: '' }
    const server = net.createServer(socket => {
      if (pipe.socket) pipe.socket.destroy()
      pipe.socket = socket
      socket.setNoDelay(true)
      socket.on('data', () => {})
      socket.on('error', () => {})
      socket.on('close', () => {
        if (pipe.socket === socket) pipe.socket = null
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      server.on('error', () => {})
      pipe.server = server
      pipe.source = `tcp://127.0.0.1:${server.address().port}`
      resolve(pipe)
    })
  })
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
  if (pipe.socket) pipe.socket.destroy()
  pipe.socket = null
  try {
    pipe.server?.close()
  } catch {}
  pipe.server = null
}

function sendNote(session, text) {
  session.conn.sendMessage(session.chat, { text }).catch(() => {})
}

function liveStartArgs(url) {
  return /\.m3u8/i.test(url) ? ['-live_start_index', '-1'] : []
}

function relayChunk(pipe, chunk) {
  const socket = pipe.socket
  if (!socket || socket.destroyed || socket.writableLength > tv.relayBufferBytes) return
  socket.write(chunk)
}

function spawnWriter(session, pipe, url) {
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-user_agent', tv.userAgent,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...liveStartArgs(url),
    '-i', url,
    '-an', '-sn', '-dn', '-c:v', 'copy',
    '-f', 'mpegts', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  pipe.writer = proc
  proc.stdout.on('data', chunk => {
    if (pipe.writer === proc) relayChunk(pipe, chunk)
  })
  proc.stdout.on('error', () => {})
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
  return 'Waiting for viewers...'
}

function tvStatusText(session) {
  const lines = [
    `📺 *${session.channel.name}*`,
    `Quality: ${session.quality}`,
    `Status: ${tvStatusLabel(session)}`
  ]
  if (session.phase !== 'closed' && session.link) lines.push(`Join: ${session.link.replace(/^https?:\/\//i, '')}`)
  return lines.join('\n')
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
    if (pipe.source === session.loadedSource) keep.push(pipe)
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
  clearTimeout(session.waitTimer)
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
    if (info.isActive && !session.connected) {
      session.connected = true
      session.phase = 'playing'
      session.writerRetries = 0
      clearTimeout(session.waitTimer)
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
  let room
  try {
    room = await voip.createRoom('silence', videoConfigOf(quality), {
      isVideo: true,
      autoEndCall: false,
      autoDowngrade: false,
      safetyMs: tv.joinWaitMs * 2
    })
  } catch (err) {
    throw `Failed to create the TV room: ${err?.message || err}`
  }
  const callId = room.callId

  const session = {
    conn,
    chat: m.chat,
    requester: m.sender,
    coordinator,
    callId,
    link: room.link,
    channel,
    quality,
    pipe: null,
    loadedSource: null,
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
    listeners: [],
    waitTimer: null
  }
  room.on('error', err => {
    if (!session.closed) sendNote(session, `TV error: ${err?.message || err}`)
  })
  bindCallEvents(session)
  tv.sessions.set(m.chat, session)
  session.waitTimer = setTimeout(() => {
    if (session.closed || session.connected) return
    coordinator.endCall(callId).catch(() => {})
    sendNote(session, 'Nobody joined the TV room in time, so it was closed. Send .tv to start again.')
    finishTvSession(session, 'no viewers')
  }, tv.joinWaitMs)
  session.waitTimer.unref?.()

  try {
    session.pipe = await openPipe()
    await coordinator.loadAudio(callId, channel.url)
    await coordinator.loadVideo(callId, session.pipe.source)
    session.loadedSource = session.pipe.source
    if (session.connected) startWriter(session)
  } catch (err) {
    coordinator.endCall(callId).catch(() => {})
    finishTvSession(session, 'failed')
    throw `Failed to start the stream: ${err?.message || err}`
  }

  if (session.closed) throw 'The TV room closed before it started.'
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
  if (session.loadedSource !== session.pipe.source) {
    try {
      await session.coordinator.swapVideoSource(session.callId, session.pipe.source)
    } catch (err) {
      sendNote(session, `TV error: ${err?.message || err}`)
      return
    }
    session.loadedSource = session.pipe.source
  }
  releaseRetired(session)
}

async function tuneSession(session, channel) {
  if (!session.connected) throw 'Wait until someone joins the TV room.'
  if (session.channel.url === channel.url) throw `${channel.name} is already playing.`

  const previous = session.pipe
  const next = await openPipe()
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
  if (!session.connected) throw 'Wait until someone joins the TV room.'
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
  if (!query) return sendCountryList(m, { conn, usedPrefix })

  const [first, ...rest] = query.split(/\s+/)
  if (first.toLowerCase() === 'list') {
    const filter = rest.join(' ').trim().toLowerCase()
    if (!filter) return sendCountryList(m, { conn, usedPrefix })
    const { channels, version } = await loadCatalog()
    return sendChannelSelect(m, { conn, usedPrefix }, listEntries(channels, filter), version, `TV Channels - ${filter}`)
  }

  const lower = query.toLowerCase()
  const { channels, version } = await loadCatalog()
  if (isCountryQuery(channels, lower)) {
    const entries = exactCountryEntries(channels, lower)
    return sendChannelSelect(m, { conn, usedPrefix }, entries, version, `TV Channels - ${entries[0]?.country || lower}`)
  }

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
    description: 'Browse live TV channels by country, or watch one through a call link at its own resolution',
    help: ['tv', 'tv <country>', 'tv list [filter]', 'tv <channel name or stream url>'],
    tags: ['internet'],
    ai: { risk: 'low', description: 'browse and watch live TV channels through a WhatsApp call link' },
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
