import fs from 'fs'
import path from 'path'
import os from 'os'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { spawnSync } from 'child_process'
import chalk from '../../lib/utils/color.js'
import { ButtonStyle, ComponentType } from '../../lib/package/discord/constants.js'

const EMBED_COLOR = 0x5865f2
const MAX_QUEUE = 100
const IDLE_LEAVE_MS = 2 * 60 * 1000
const ALONE_LEAVE_MS = 60 * 1000
const CONTROLS_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_VOLUME = 200
const MIN_VOLUME = 1
const MAX_VOLUME = 200
const HISTORY_LIMIT = 50
const PAST_LIMIT = 50
const RESTART_THRESHOLD_MS = 3000
const AUTOPLAY_CANDIDATES = 10
const AUTOPLAY_MIN_SECONDS = 30
const AUTOPLAY_MAX_SECONDS = 15 * 60
const AUTOPLAY_MAX_FAILURES = 3
const PROBE_TIMEOUT_MS = 15000
const EPHEMERAL = 64
const PREV_LABEL = '\u25C0\uFE0E'
const NEXT_LABEL = '\u25B6\uFE0E'
const LOOP_LABEL = '\u27F3'
const YOUTUBE_ID = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/)|[?&]v=)([a-zA-Z0-9_-]{11})/

const TMP_DIR = path.join(os.tmpdir(), 'hirobot-music')
const MAX_TRACK_BYTES = 80 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
const sessions = (global.discordMusicSessions ||= new Map())
let ffmpegOk = null

if (!global.discordMusicReady) {
  global.discordMusicReady = true
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
}

class MusicError extends Error {}

function hasFfmpeg() {
  if (ffmpegOk === null) {
    try {
      ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
    } catch {
      ffmpegOk = false
    }
  }
  return ffmpegOk
}

function trackLine(track) {
  const title = String(track.title || 'Unknown').replace(/[[\]]/g, '')
  const label = title.length > 70 ? `${title.slice(0, 69)}…` : title
  return track.direct || !track.url ? label : `[${label}](${track.url})`
}

function embed(data) {
  return { color: EMBED_COLOR, ...data }
}

function footerOf(session) {
  return { text: `Volume ${Math.round(session.volume * 100)}% • Loop ${session.loop} • Autoplay ${session.autoplay ? 'on' : 'off'}` }
}

function tempFile() {
  fs.mkdirSync(TMP_DIR, { recursive: true })
  return path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`)
}

async function downloadToFile(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new MusicError(`Audio source returned ${res.status}`)

  let size = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > MAX_TRACK_BYTES) return callback(new MusicError('Track is too large'))
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file))
}

async function probeStream(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-1' },
    redirect: 'follow',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  try {
    await res.body?.cancel()
  } catch {}
  return res.ok
}

async function saveUrl(url) {
  const file = tempFile()
  try {
    await downloadToFile(url, file)
    return { file }
  } catch (err) {
    await fs.promises.unlink(file).catch(() => {})
    throw err
  }
}

async function fetchYoutube(track) {
  const scraper = global.scraper?.ytdl
  if (!scraper) throw new MusicError('YouTube downloader is not available.')

  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (typeof scraper.ytdlUrl === 'function') {
        const info = await scraper.ytdlUrl('audio', track.url)
        if (await probeStream(info.url).catch(() => false)) return { url: info.url }
        return await saveUrl(info.url)
      }
      const data = await scraper.ytdl('audio', track.url)
      if (!data?.buffer?.length) throw new Error('empty audio')
      const file = tempFile()
      await fs.promises.writeFile(file, data.buffer)
      return { file }
    } catch (err) {
      lastError = err
    }
  }
  throw new MusicError(lastError?.message || 'Failed to load the audio')
}

function makeTrack(info, requestedBy, { autoplay = false } = {}) {
  const track = {
    title: info.title,
    url: info.url,
    duration: info.duration || '',
    thumbnail: info.thumbnail || null,
    author: info.author || '',
    direct: !!info.direct,
    autoplay,
    requestedBy,
    data: null,
    pending: null,
    load() {
      if (track.data) return Promise.resolve(track.data)
      if (!track.pending) {
        const pending = (track.direct ? Promise.resolve({ url: track.url }) : fetchYoutube(track))
          .then(data => {
            if (track.pending === pending) track.data = data
            return data
          })
          .catch(err => {
            if (track.pending === pending) track.pending = null
            throw err
          })
        track.pending = pending
      }
      return track.pending
    },
    release() {
      const pending = track.pending
      const file = track.data?.file
      track.data = null
      track.pending = null
      if (file) fs.promises.unlink(file).catch(() => {})
      else if (pending) pending.then(data => data?.file && fs.promises.unlink(data.file)).catch(() => {})
    }
  }
  return track
}

async function resolveTrack(query, requestedBy) {
  const yts = global.scraper?.ytsearch?.search
  if (typeof yts !== 'function') throw new MusicError('YouTube search is not available.')
  const link = /https?:\/\/\S+/i.exec(query)?.[0]

  if (link) {
    const id = YOUTUBE_ID.exec(link)?.[1]
    if (!id) {
      const name = decodeURIComponent(path.basename(new URL(link).pathname)) || link
      return makeTrack({ title: name, url: link, direct: true }, requestedBy)
    }
    const meta = await yts({ videoId: id }).catch(() => null)
    return makeTrack({
      title: meta?.title || link,
      url: `https://www.youtube.com/watch?v=${id}`,
      duration: meta?.duration?.timestamp || meta?.timestamp,
      thumbnail: meta?.thumbnail,
      author: meta?.author?.name
    }, requestedBy)
  }

  const result = await yts(query).catch(() => null)
  const video = result?.videos?.[0]
  if (!video) throw new MusicError('No results found.')
  return makeTrack({
    title: video.title,
    url: video.url,
    duration: video.timestamp,
    thumbnail: video.thumbnail || video.image,
    author: video.author?.name
  }, requestedBy)
}

function trackId(track) {
  return YOUTUBE_ID.exec(track.url || '')?.[1] || track.url || ''
}

function rememberTrack(session, track) {
  const id = trackId(track)
  if (!id) return
  session.history.push(id)
  if (session.history.length > HISTORY_LIMIT) session.history.shift()
}

function rememberPast(session, track) {
  session.past.push(track)
  if (session.past.length > PAST_LIMIT) session.past.shift()
}

function cleanSeed(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(official|lyrics?|audio|video|music|mv|hd|4k|visualizer|remaster(?:ed)?)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'&-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function autoplayQueries(seed) {
  const artist = cleanSeed(String(seed.author || '').replace(/\s*-?\s*(VEVO|Topic)$/i, ''))
  const title = cleanSeed(seed.title)
  const queries = []
  if (artist) queries.push(`${artist} songs`)
  if (title) queries.push(title)
  return queries
}

async function findAutoplayVideo(session, seed) {
  const search = global.scraper?.ytsearch?.search
  if (typeof search !== 'function') return null
  for (const query of autoplayQueries(seed)) {
    const result = await search(query).catch(() => null)
    const pool = (result?.videos || [])
      .filter(video => video?.videoId && video.url
        && !session.history.includes(video.videoId)
        && video.seconds >= AUTOPLAY_MIN_SECONDS
        && video.seconds <= AUTOPLAY_MAX_SECONDS)
      .slice(0, AUTOPLAY_CANDIDATES)
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)]
  }
  return null
}

async function autoplayNext(session, seed) {
  if (!session.autoplay || seed.direct || session.autoplayFailures >= AUTOPLAY_MAX_FAILURES) return null
  const video = await findAutoplayVideo(session, seed).catch(() => null)
  if (!video) return null
  return makeTrack({
    title: video.title,
    url: video.url,
    duration: video.timestamp,
    thumbnail: video.thumbnail || video.image,
    author: video.author?.name
  }, null, { autoplay: true })
}

function dropPendingAuto(session) {
  const pending = session.pendingAuto
  session.pendingAuto = null
  pending?.then(track => track?.release())
}

function prefetchNext(session) {
  const upcoming = session.queue[0]
  if (upcoming) {
    if (!upcoming.direct) upcoming.load().catch(() => {})
    return
  }
  const seed = session.lastTrack
  if (!session.autoplay || !seed || seed.direct || session.pendingAuto) return
  session.pendingAuto = autoplayNext(session, seed)
    .then(track => {
      if (track && !track.direct) track.load().catch(() => {})
      return track
    })
    .catch(() => null)
}

function notify(session, payload) {
  const channel = session.textChannel
  if (!channel?.send) return
  channel.send({ allowedMentions: { parse: [] }, ...payload }).catch(() => {})
}

const isButton = ctx => ctx.interaction?.isButton?.() === true

async function acknowledge(ctx) {
  const interaction = ctx.interaction
  if (!interaction || interaction.deferred || interaction.replied) return
  await interaction.deferUpdate().catch(() => {})
}

function say(ctx, content) {
  if (isButton(ctx)) return null
  return ctx.reply(content)
}

function renderNowPlaying(session, track, { title = 'Now playing', create = true } = {}) {
  const run = async () => {
    if (sessions.get(session.guildId) !== session || !track) return
    const payload = nowPlayingPayload(session, track, title)
    if (session.nowMessage) {
      const edited = await session.nowMessage.edit(payload).then(() => true, () => false)
      if (edited) return
      session.nowMessage = null
    }
    if (!create || !session.textChannel?.send) return
    session.nowMessage = await session.textChannel.send({ allowedMentions: { parse: [] }, ...payload }).catch(() => null)
  }
  session.renderChain = (session.renderChain || Promise.resolve()).then(run).catch(() => {})
  return session.renderChain
}

function refreshNowPlaying(session) {
  if (session.current) renderNowPlaying(session, session.current, { create: false })
}

function closeNowPlaying(session) {
  const message = session.nowMessage
  session.nowMessage = null
  if (!message?.edit) return
  const last = session.current || session.lastTrack
  message.edit({
    content: null,
    embeds: [embed({
      title: 'Stopped',
      description: last ? trackLine(last) : 'Nothing is playing',
      footer: footerOf(session)
    })],
    components: []
  }).catch(() => {})
}

function nowPlayingEmbed(session, track, title = 'Now playing') {
  const fields = []
  if (track.duration) fields.push({ name: 'Duration', value: String(track.duration), inline: true })
  if (track.author) fields.push({ name: 'Channel', value: String(track.author), inline: true })
  fields.push({ name: 'Requested by', value: track.requestedBy ? `<@${track.requestedBy.id}>` : 'Autoplay', inline: true })
  return embed({
    title,
    description: trackLine(track),
    ...(track.thumbnail ? { thumbnail: { url: track.thumbnail } } : {}),
    fields,
    footer: footerOf(session)
  })
}

function controlsRows(session) {
  const button = (label, text, style = ButtonStyle.Secondary) => ({
    type: ComponentType.Button,
    style,
    label,
    custom_id: `hb:b:${session.registerAction(text, { shared: true, ttl: CONTROLS_TTL_MS })}`
  })
  return [{
    type: ComponentType.ActionRow,
    components: [
      button(PREV_LABEL, '.previous'),
      button('Pause', '.toggle'),
      button(NEXT_LABEL, '.skip'),
      button(LOOP_LABEL, '.loop'),
      button('Stop', '.stop', ButtonStyle.Danger)
    ]
  }]
}

function nowPlayingPayload(session, track, title) {
  return { content: null, embeds: [nowPlayingEmbed(session, track, title)], components: controlsRows(session) }
}

function clearIdle(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer)
  session.idleTimer = null
}

function scheduleLeave(session, ms, reason) {
  clearIdle(session)
  session.idleTimer = setTimeout(() => {
    notify(session, { content: reason })
    destroySession(session.guildId)
  }, ms)
  session.idleTimer.unref?.()
}

function destroySession(guildId) {
  const session = sessions.get(guildId)
  if (!session) return
  sessions.delete(guildId)
  clearIdle(session)
  if (session.aloneTimer) clearTimeout(session.aloneTimer)
  session.aloneTimer = null
  session.stopping = true
  session.jumpTo = null
  dropPendingAuto(session)
  closeNowPlaying(session)
  for (const queued of session.queue) queued.release()
  session.queue.length = 0
  session.current?.release()
  session.current = null
  try {
    session.player.stop(true)
  } catch {}
  try {
    session.connection.destroy()
  } catch {}
}

async function playTrack(session, track, { silent = false, rethrow = false } = {}) {
  session.current = track
  clearIdle(session)

  try {
    const data = await track.load()
    if (session.current !== track || sessions.get(session.guildId) !== session) return false
    session.player.play(data.file || data.url, { volume: session.volume, userAgent: data.file ? null : USER_AGENT })
    session.lastTrack = track
    rememberTrack(session, track)
    if (track.autoplay) session.autoplayFailures = 0
    if (!silent) renderNowPlaying(session, track)
    dropPendingAuto(session)
    prefetchNext(session)
    return true
  } catch (err) {
    track.release()
    rememberTrack(session, track)
    if (track.autoplay) session.autoplayFailures += 1
    session.current = null
    if (rethrow) throw err
    notify(session, { content: `Failed to play **${track.title}**: ${err?.message || err}` })
    await advance(session, { forceNext: true })
    return false
  }
}

async function advance(session, { forceNext = false } = {}) {
  if (session.stopping || sessions.get(session.guildId) !== session) return
  const finished = session.current
  const skipped = session.skipping || forceNext
  session.skipping = false

  if (session.jumpTo) {
    const target = session.jumpTo
    session.jumpTo = null
    finished?.release()
    await playTrack(session, target)
    return
  }

  let next = null
  if (finished && session.loop === 'track' && !skipped) {
    next = finished
  } else {
    finished?.release()
    if (finished) rememberPast(session, finished)
    if (finished && session.loop === 'queue') session.queue.push(finished)
    next = session.queue.shift() || null
  }

  if (!next && session.autoplay && session.lastTrack) {
    const pending = session.pendingAuto
    session.pendingAuto = null
    const fresh = pending ? await pending : await autoplayNext(session, session.lastTrack).catch(() => null)
    if (session.stopping || sessions.get(session.guildId) !== session) {
      fresh?.release()
      return
    }
    if (session.queue.length) {
      fresh?.release()
      next = session.queue.shift()
    } else {
      next = fresh
    }
  }

  if (!next) {
    session.current = null
    scheduleLeave(session, IDLE_LEAVE_MS, 'Left the voice channel because the queue has been empty for a while.')
    return
  }
  await playTrack(session, next, { silent: next === finished })
}

async function createSession(ctx, voiceChannel) {
  if (!hasFfmpeg()) throw new MusicError('ffmpeg is not installed on this host, music cannot be played.')
  const guild = voiceChannel.guild
  let connection
  try {
    connection = await ctx.client.voice.join({ guildId: guild.id, channelId: voiceChannel.id, selfDeaf: true, timeout: 20000 })
  } catch (err) {
    console.error(chalk.red('Discord') + chalk.gray(` voice join failed: ${err?.message || err}`))
    throw new MusicError(`I could not join the voice channel (${err?.message || 'unknown error'}).`)
  }

  const session = {
    guildId: guild.id,
    channelId: voiceChannel.id,
    connection,
    player: connection.player,
    queue: [],
    current: null,
    lastTrack: null,
    past: [],
    jumpTo: null,
    pendingAuto: null,
    history: [],
    volume: DEFAULT_VOLUME / 100,
    loop: 'off',
    autoplay: true,
    autoplayFailures: 0,
    textChannel: ctx.channel,
    registerAction: ctx.registerAction,
    idleTimer: null,
    stopping: false,
    skipping: false,
    aloneTimer: null,
    nowMessage: null,
    renderChain: null
  }

  session.player.on('idle', () => {
    advance(session).catch(err => console.error(chalk.red('Discord') + chalk.gray(' music error:'), err))
  })
  session.player.on('error', err => {
    notify(session, { content: `Playback error: ${err?.message || err}` })
  })
  connection.on('destroyed', () => {
    if (sessions.get(session.guildId) === session) destroySession(session.guildId)
  })

  sessions.set(guild.id, session)
  return session
}

function userVoice(ctx) {
  return ctx.member?.voice?.channel || null
}

function checkVoicePermissions(ctx, channel) {
  const me = ctx.guild?.members?.me
  const perms = me ? channel.permissionsFor(me) : null
  if (perms && !(perms.has('Connect') && perms.has('Speak') && perms.has('ViewChannel'))) {
    throw new MusicError('I need the View Channel, Connect and Speak permissions in that voice channel.')
  }
}

function requireSession(ctx) {
  const session = sessions.get(ctx.guild?.id)
  if (!session) throw new MusicError('Nothing is playing right now.')
  const channel = userVoice(ctx)
  if (!ctx.isOwner && channel?.id !== session.channelId) {
    throw new MusicError(`Join <#${session.channelId}> to control the music.`)
  }
  return session
}

async function guard(ctx, fn) {
  if (isButton(ctx)) await acknowledge(ctx)
  try {
    return await fn()
  } catch (err) {
    if (err instanceof MusicError) {
      if (isButton(ctx)) await ctx.interaction.followUp({ content: err.message, flags: EPHEMERAL }).catch(() => {})
      else await ctx.reply({ ephemeral: true, content: err.message }).catch(() => {})
      ctx.failed = true
      return null
    }
    throw err
  }
}

function play(ctx, query) {
  return guard(ctx, async () => {
    const text = String(query || '').trim()
    if (!text) throw new MusicError('Tell me what to play: a song name or a YouTube link.')
    const channel = userVoice(ctx)
    if (!channel) throw new MusicError('Join a voice channel first.')
    checkVoicePermissions(ctx, channel)

    await ctx.defer()
    const existing = sessions.get(ctx.guild.id)
    if (existing && existing.channelId !== channel.id && (existing.current || existing.queue.length)) {
      throw new MusicError(`I am already playing in <#${existing.channelId}>.`)
    }
    if (existing && existing.queue.length >= MAX_QUEUE) throw new MusicError(`The queue is full (${MAX_QUEUE} tracks).`)

    const track = await resolveTrack(text, ctx.discordUser)
    if (!existing?.current) track.load().catch(() => {})

    let session = existing
    if (session && session.channelId !== channel.id) {
      destroySession(ctx.guild.id)
      session = null
    }
    if (!session) {
      try {
        session = await createSession(ctx, channel)
      } catch (err) {
        track.release()
        throw err
      }
    }
    session.textChannel = ctx.channel
    session.stopping = false
    session.autoplayFailures = 0

    if (!session.current) {
      const hadMessage = !!session.nowMessage
      try {
        await playTrack(session, track, { silent: true, rethrow: true })
      } catch (err) {
        if (!session.queue.length) destroySession(ctx.guild.id)
        throw new MusicError(`Failed to play **${track.title}**: ${err?.message || err}`)
      }
      if (hadMessage) {
        renderNowPlaying(session, track)
        await ctx.reply({ ephemeral: true, content: `Playing **${track.title}**.` })
        return
      }
      const sent = await ctx.reply(nowPlayingPayload(session, track))
      session.nowMessage = sent?.edit ? sent : null
      return
    }

    session.queue.push(track)
    if (session.queue.length === 1 && !track.direct) track.load().catch(() => {})
    await ctx.reply({
      embeds: [embed({
        title: 'Added to queue',
        description: trackLine(track),
        ...(track.thumbnail ? { thumbnail: { url: track.thumbnail } } : {}),
        fields: [
          { name: 'Position', value: String(session.queue.length), inline: true },
          ...(track.duration ? [{ name: 'Duration', value: String(track.duration), inline: true }] : [])
        ]
      })]
    })
  })
}

function previous(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    const current = session.current
    if (!current || !session.player.playing) throw new MusicError('Nothing is playing right now.')
    const restart = session.player.position > RESTART_THRESHOLD_MS || !session.past.length
    const prev = restart ? null : session.past.pop()
    if (!prev) {
      await playTrack(session, current, { silent: true })
      await say(ctx, 'Restarted the song.')
      return
    }
    session.queue.unshift(current)
    session.jumpTo = prev
    session.player.stop()
    await say(ctx, 'Playing the previous song.')
  })
}

function skip(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (!session.player.playing) throw new MusicError('Nothing is playing right now.')
    const title = session.current?.title || 'the current song'
    session.skipping = true
    session.player.stop()
    await say(ctx, `Skipped **${title}**.`)
  })
}

function stop(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    destroySession(session.guildId)
    await say(ctx, 'Stopped the music and left the voice channel.')
  })
}

function toggle(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (!session.player.playing) throw new MusicError('Nothing is playing right now.')
    if (session.player.paused) {
      session.player.unpause()
      await say(ctx, 'Resumed.')
      return
    }
    session.player.pause()
    await say(ctx, 'Paused.')
  })
}

function pause(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (!session.player.playing) throw new MusicError('Nothing is playing right now.')
    session.player.pause()
    await say(ctx, 'Paused.')
  })
}

function resume(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (!session.player.playing) throw new MusicError('Nothing is playing right now.')
    session.player.unpause()
    await say(ctx, 'Resumed.')
  })
}

function nowPlaying(ctx) {
  return guard(ctx, async () => {
    const session = sessions.get(ctx.guild?.id)
    if (!session?.current) throw new MusicError('Nothing is playing right now.')
    await ctx.reply(nowPlayingPayload(session, session.current))
  })
}

function queue(ctx) {
  return guard(ctx, async () => {
    const session = sessions.get(ctx.guild?.id)
    if (!session?.current && !session?.queue.length) throw new MusicError('The queue is empty.')

    const lines = session.queue.slice(0, 10).map((t, i) => `${i + 1}. ${trackLine(t)}${t.duration ? ` \`${t.duration}\`` : ''}`)
    const more = session.queue.length > 10 ? `\n…and ${session.queue.length - 10} more` : ''
    const upNext = lines.length
      ? `**Up next**\n${lines.join('\n')}${more}`
      : session.autoplay ? 'Autoplay will pick the next song.' : 'Nothing queued after this.'
    await ctx.reply({
      embeds: [embed({
        title: 'Queue',
        description: [
          session.current ? `**Now playing**\n${trackLine(session.current)}` : '',
          upNext
        ].filter(Boolean).join('\n\n'),
        footer: footerOf(session)
      })]
    })
  })
}

function setVolume(ctx, value) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (value === undefined || value === null || value === '') {
      return say(ctx, `Volume is ${Math.round(session.volume * 100)}%.`)
    }
    const percent = Number(value)
    if (!Number.isFinite(percent) || percent < MIN_VOLUME || percent > MAX_VOLUME) {
      throw new MusicError(`Volume must be between ${MIN_VOLUME} and ${MAX_VOLUME}.`)
    }
    session.volume = Math.round(percent) / 100
    session.player.setVolume(session.volume)
    refreshNowPlaying(session)
    await say(ctx, `Volume set to ${Math.round(percent)}%.`)
  })
}

function setLoop(ctx, mode) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    const value = String(mode || '').toLowerCase()
    const next = ['off', 'track', 'queue'].includes(value) ? value : session.loop === 'off' ? 'track' : session.loop === 'track' ? 'queue' : 'off'
    session.loop = next
    refreshNowPlaying(session)
    await say(ctx, `Loop is now **${next}**.`)
  })
}

function setAutoplay(ctx, mode) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    const value = String(mode || '').toLowerCase()
    if (['on', 'true', 'yes', '1'].includes(value)) session.autoplay = true
    else if (['off', 'false', 'no', '0'].includes(value)) session.autoplay = false
    else session.autoplay = !session.autoplay
    if (session.autoplay) session.autoplayFailures = 0
    if (!session.autoplay) dropPendingAuto(session)
    refreshNowPlaying(session)
    await say(ctx, `Autoplay is now **${session.autoplay ? 'on' : 'off'}**.`)
  })
}

function shuffle(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    if (session.queue.length < 2) throw new MusicError('Not enough tracks in the queue to shuffle.')
    for (let i = session.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[session.queue[i], session.queue[j]] = [session.queue[j], session.queue[i]]
    }
    await say(ctx, 'Queue shuffled.')
  })
}

function remove(ctx, position) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    const index = Number(position)
    if (!Number.isInteger(index) || index < 1 || index > session.queue.length) {
      throw new MusicError(`Pick a position between 1 and ${session.queue.length || 1}.`)
    }
    const [removed] = session.queue.splice(index - 1, 1)
    removed.release()
    await say(ctx, `Removed **${removed.title}** from the queue.`)
  })
}

function join(ctx) {
  return guard(ctx, async () => {
    const channel = userVoice(ctx)
    if (!channel) throw new MusicError('Join a voice channel first.')
    checkVoicePermissions(ctx, channel)
    await ctx.defer()
    const existing = sessions.get(ctx.guild.id)
    if (existing?.channelId === channel.id) return say(ctx, `I am already in <#${channel.id}>.`)
    if (existing && (existing.current || existing.queue.length)) throw new MusicError(`I am already playing in <#${existing.channelId}>.`)
    if (existing) destroySession(ctx.guild.id)
    const session = await createSession(ctx, channel)
    scheduleLeave(session, IDLE_LEAVE_MS, 'Left the voice channel because nothing was played.')
    await say(ctx, `Joined <#${channel.id}>.`)
  })
}

function leave(ctx) {
  return guard(ctx, async () => {
    const session = requireSession(ctx)
    destroySession(session.guildId)
    await say(ctx, 'Left the voice channel.')
  })
}

function handleVoiceState(oldState, newState) {
  const guildId = newState.guild?.id || oldState.guild?.id
  const session = sessions.get(guildId)
  if (!session) return

  const me = newState.client?.user?.id
  if (newState.id === me && !newState.channelId) {
    destroySession(guildId)
    return
  }

  const channel = newState.guild.channels.cache.get(session.channelId)
  if (!channel?.members) return
  const humans = channel.members.filter(member => !member.user.bot).size
  if (humans === 0) {
    if (!session.aloneTimer) {
      session.aloneTimer = setTimeout(() => {
        session.aloneTimer = null
        const current = newState.guild.channels.cache.get(session.channelId)
        if (sessions.get(guildId) === session && current?.members?.filter(member => !member.user.bot).size === 0) {
          notify(session, { content: 'Left the voice channel because everyone left.' })
          destroySession(guildId)
        }
      }, ALONE_LEAVE_MS)
      session.aloneTimer.unref?.()
    }
  } else if (session.aloneTimer) {
    clearTimeout(session.aloneTimer)
    session.aloneTimer = null
  }
}

function stopAllMusic() {
  for (const guildId of [...sessions.keys()]) destroySession(guildId)
}

global.discordMusic = { handleVoiceState, stopAllMusic, getSession: guildId => sessions.get(guildId) || null, destroySession }

const base = { category: 'Music', group: true }

const commands = [
  {
    ...base,
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or add it to the queue',
    help: [{ name: 'query', description: 'Song name or YouTube link', type: 'string', required: true }],
    run: ctx => play(ctx, ctx.args.query)
  },
  { ...base, name: 'previous', aliases: ['prev', 'back'], description: 'Play the previous song, or restart the current one', run: ctx => previous(ctx) },
  { ...base, name: 'skip', aliases: ['next'], description: 'Skip the current song', run: ctx => skip(ctx) },
  { ...base, name: 'stop', description: 'Stop the music and leave the voice channel', run: ctx => stop(ctx) },
  { ...base, name: 'pause', description: 'Pause the music', run: ctx => pause(ctx) },
  { ...base, name: 'resume', aliases: ['unpause'], description: 'Resume the music', run: ctx => resume(ctx) },
  { ...base, name: 'toggle', description: 'Pause or resume the music', hidden: true, prefixOnly: true, run: ctx => toggle(ctx) },
  { ...base, name: 'queue', aliases: ['q'], description: 'Show the music queue', run: ctx => queue(ctx) },
  { ...base, name: 'nowplaying', aliases: ['np'], description: 'Show the song that is playing', run: ctx => nowPlaying(ctx) },
  {
    ...base,
    name: 'volume',
    aliases: ['vol'],
    description: 'Set the music volume (1-200, default 200)',
    help: [{ name: 'percent', description: 'Volume from 1 to 200', type: 'integer', min_value: 1, max_value: 200 }],
    run: ctx => setVolume(ctx, ctx.args.percent)
  },
  {
    ...base,
    name: 'loop',
    aliases: ['repeat'],
    description: 'Set loop mode: off, track or queue',
    help: [{
      name: 'mode',
      description: 'off, track or queue',
      type: 'string',
      choices: [{ name: 'off', value: 'off' }, { name: 'track', value: 'track' }, { name: 'queue', value: 'queue' }]
    }],
    run: ctx => setLoop(ctx, ctx.args.mode)
  },
  {
    ...base,
    name: 'autoplay',
    aliases: ['ap'],
    description: 'Keep playing similar songs when the queue is empty',
    help: [{
      name: 'mode',
      description: 'on or off, toggles when empty',
      type: 'string',
      choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }]
    }],
    run: ctx => setAutoplay(ctx, ctx.args.mode)
  },
  { ...base, name: 'shuffle', description: 'Shuffle the queue', run: ctx => shuffle(ctx) },
  {
    ...base,
    name: 'remove',
    description: 'Remove a song from the queue',
    help: [{ name: 'position', description: 'Position in the queue', type: 'integer', required: true, min_value: 1 }],
    run: ctx => remove(ctx, ctx.args.position)
  },
  { ...base, name: 'join', aliases: ['summon'], description: 'Join your voice channel', run: ctx => join(ctx) },
  { ...base, name: 'leave', aliases: ['disconnect', 'dc'], description: 'Leave the voice channel', run: ctx => leave(ctx) }
]

const compat = (m, extra) => ({
  reply: m.reply,
  guild: m.guild,
  member: m.member,
  channel: m.channel,
  inGuild: m.isGroup,
  discordUser: m.user,
  interaction: m.interaction,
  client: extra.conn.client,
  args: extra.args,
  text: extra.text,
  prefix: extra.usedPrefix,
  command: extra.command,
  isOwner: extra.isOwner,
  defer: m.defer,
  failed: false,
  registerAction: (text, opts = {}) => extra.conn.registerAction(opts.shared ? null : m.sender, text, opts.ttl)
})

const toHandler = spec => Object.assign(async (m, extra) => spec.run(compat(m, extra)), {
  command: [spec.name, ...(spec.aliases || [])],
  description: spec.description,
  tags: [spec.category || 'Music'],
  group: !!spec.group,
  help: spec.help || [],
  hidden: !!spec.hidden,
  prefixOnly: !!spec.prefixOnly
})

const discordHandlers = commands.map(toHandler).map(h => Object.assign(h, { platform: { whatsapp: false, discord: true } }))
const discordPlay = discordHandlers[0]

const waSearch = global.scraper.ytsearch.search
const waYtdl = global.scraper.ytdl.ytdl

async function waPlay(m, { conn, text, usedPrefix, command }) {
  if (!text) throw `- [PlayAudio] ${usedPrefix + command} music\n- [PlayVideo] ${usedPrefix + command} video_name --video`
  const link = String(text).match(/https?:\/\/\S+/i)
  const isVideo = /--video/.test(text)
  const query = String(text).replace(/--video/g, '').trim()
  const input = link ? link[0] : (await waSearch(query)).videos[0].url
  m.react('🎶')

  const data = await waYtdl(isVideo ? 'video' : 'audio', input)
  const description = `\`${data.title}\`\n\n- *Duration:* ${data.duration}\n- *Views:* ${(data.views).toSimpleNumber ? data.views.toSimpleNumber() : data.views}\n- *Url:* ${input.replace('https://', '')}`
  let thumbBuffer = null
  if (data.thumbnail) {
    try { thumbBuffer = await conn.resize(await (await fetch(data.thumbnail)).buffer(), 150, 150) } catch (_) {}
  }
  conn.reply(m.chat, description, { key: { remoteJid: '0@s.whatsapp.net' }, message: { orderMessage: { orderId: '780642630945098', thumbnail: thumbBuffer, itemCount: 666, status: 1, surface: 1, message: 'YOUTUBE DOWNLOADER', orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: '0', totalCurrencyCode: 'IDR' } } })
  await conn.sendMessage(m.chat, {
    [isVideo ? 'video' : 'audio']: data.buffer,
    mimetype: data.mime,
    asDocument: db.data.chats[m.chat].useDocument,
    fileName: isVideo ? 'YouTube.mp4' : 'YouTube.mp3'
  }, {})
}

const playHandler = Object.assign(async (m, extra) => {
  if (extra.platform === 'discord') {
    if (!m.isGroup) return m.reply('This command only works in a server.')
    return discordPlay(m, extra)
  }
  return waPlay(m, extra)
}, {
  command: discordPlay.command,
  description: discordPlay.description,
  tags: ['Music', 'downloader'],
  help: discordPlay.help,
  ai: { risk: 'low', description: 'play music or video from youtube' },
  platform: { whatsapp: true, discord: true }
})

export default [playHandler, ...discordHandlers.slice(1)]
