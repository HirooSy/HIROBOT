import { spawn } from 'child_process'

const API = 'https://api-v2.soundcloud.com'
const UA  ='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let cachedClientId = null

export async function fetchClientId() {
  if (cachedClientId) return cachedClientId

  const html = await (await fetch('https://soundcloud.com/', {
    headers: { 'User-Agent': UA }
  })).text()

  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)]
    .map(m => m[1])
    .reverse()

  for (const src of scripts) {
    try {
      const js = await (await fetch(src, { headers: { 'User-Agent': UA } })).text()
      const m = js.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/)
      if (m) {
        cachedClientId = m[1]
        return cachedClientId
      }
    } catch {}
  }
  throw new Error('Gagal mengambil client_id dari SoundCloud')
}

async function api(path, params = {}) {
  const client_id = await fetchClientId()

  let full
  try {
    full = path.startsWith('http') ? new URL(path) : new URL(path, API)
  } catch {
    throw new Error('Path API tidak valid')
  }

  full.searchParams.set('client_id', client_id)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) full.searchParams.set(k, String(v))
  }

  const res = await fetch(full, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow'
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text.slice(0, 180)}`)
  }
  return res.json()
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('URL kosong atau tidak valid')

  let url = input.trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '')

  url = url.replace(/^https?:\/\/m\.soundcloud\.com/i, 'https://soundcloud.com')

  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/^http:/i, 'https:')

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Format URL tidak dikenali')
  }

  if (!parsed.hostname.endsWith('soundcloud.com') &&
      !parsed.hostname.includes('snd.sc') &&
      !parsed.hostname.includes('on.soundcloud')) {
    throw new Error('Bukan URL SoundCloud')
  }

  parsed.hash = ''
  parsed.search = ''
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '')
}

export async function resolve(url) {
  let clean = normalizeUrl(url)

  if (/on\.soundcloud\.com|snd\.sc|soundcloud\.app\.goo\.gl/i.test(clean)) {
    try {
      const r = await fetch(clean, {
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      })
      const loc = r.headers.get('location')
      if (loc) clean = normalizeUrl(loc)
    } catch {}
  }

  let data = await api('/resolve', { url: clean })

  if (!data?.kind) {
    const alt = clean.replace('://soundcloud.com', '://www.soundcloud.com')
    data = await api('/resolve', { url: alt }).catch(() => null)
  }

  if (!data?.kind) throw new Error(`Gagal resolve: ${clean}`)
  return data
}

async function resolveStream(transcoding) {
  if (!transcoding?.url) return null
  try {
    const data = await api(transcoding.url)
    return data?.url || null
  } catch {
    return null
  }
}

async function formatTrack(track) {
  const trans = track.media?.transcodings || []

  const progressive = trans.find(t =>
    t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg')
  )
  const hls = trans.find(t =>
    t.format?.protocol === 'hls' && (
      t.format?.mime_type?.includes('mpeg') || t.format?.mime_type?.includes('mp4')
    )
  )

  const [streamUrl, downloadUrl] = await Promise.all([
    resolveStream(hls || progressive),
    resolveStream(progressive || hls)
  ])

  return {
    kind: 'track',
    id: track.id,
    title: track.title,
    artist: track.user?.username || track.user?.full_name || null,
    artist_url: track.user?.permalink_url || null,
    duration: track.duration,
    duration_sec: Math.round((track.duration || 0) / 1000),
    genre: track.genre || null,
    description: track.description || null,
    permalink_url: track.permalink_url,
    artwork_url: track.artwork_url?.replace('-large', '-t500x500') || track.artwork_url || null,
    playback_count: track.playback_count,
    likes_count: track.likes_count,
    created_at: track.created_at,
    stream: streamUrl,
    download: downloadUrl || streamUrl
  }
}

async function fetchTracksByIds(ids) {
  if (!ids.length) return []
  const results = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    try {
      const data = await api('/tracks', { ids: chunk.join(','), limit: chunk.length })
      if (Array.isArray(data)) results.push(...data)
      else if (data?.collection) results.push(...data.collection)
    } catch {}
  }
  return results
}

export async function get(url) {
  const data = await resolve(url)

  if (data.kind === 'track') return formatTrack(data)

  if (data.kind === 'playlist' || data.kind === 'system-playlist') {
    const partial = data.tracks || []
    const ids = partial.map(t => t.id).filter(Boolean)

    let fullTracks = ids.length ? await fetchTracksByIds(ids) : []
    const map = new Map(fullTracks.map(t => [t.id, t]))

    const tracks = []
    for (const t of partial) {
      let track = map.get(t.id) || (t.media ? t : null)
      if (!track) track = await api(`/tracks/${t.id}`).catch(() => null)
      if (track) tracks.push(await formatTrack(track))
    }

    return {
      kind: data.kind,
      id: data.id,
      title: data.title || data.short_title || null,
      description: data.description || data.short_description || null,
      user: data.user?.username || 'SoundCloud',
      track_count: data.track_count || tracks.length,
      permalink_url: data.permalink_url,
      artwork_url: (data.artwork_url || data.calculated_artwork_url || '')
        .replace('-large', '-t500x500') || null,
      tracks
    }
  }

  return {
    kind: data.kind,
    id: data.id,
    title: data.title || data.username || data.full_name || null,
    permalink_url: data.permalink_url,
    raw: data
  }
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HLS playlist failed with status ${res.status}`)
  return res.text()
}

async function getBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HLS segment failed with status ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function segmentUrl(uri, playlistUrl) {
  const url = new URL(uri, playlistUrl)
  if (!url.search) url.search = new URL(playlistUrl).search
  return url.href
}

async function loadPlaylist(url, depth = 0) {
  const text = await getText(url)
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist')
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(text)) throw new Error('Encrypted HLS is not supported')
  if (/#EXT-X-BYTERANGE/.test(text)) throw new Error('HLS byte ranges are not supported')

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)

  const variant = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'))
  if (variant !== -1) {
    const next = lines.slice(variant + 1).find(line => !line.startsWith('#'))
    if (!next || depth) throw new Error('Invalid HLS variant playlist')
    return loadPlaylist(segmentUrl(next, url), depth + 1)
  }

  let map = null
  const segments = []
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const init = line.match(/URI="([^"]+)"/)?.[1]
      if (init) map = segmentUrl(init, url)
    } else if (!line.startsWith('#')) {
      segments.push(segmentUrl(line, url))
    }
  }

  if (!segments.length) throw new Error('HLS playlist has no segments')
  return { map, segments }
}

async function fetchSegments(urls) {
  const parts = new Array(urls.length)
  let next = 0
  let failed = false

  const worker = async () => {
    while (!failed && next < urls.length) {
      const index = next++
      try {
        parts[index] = await getBuffer(urls[index])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker))
  return parts
}

function toMp3(input) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1']
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), 180000)

    proc.stdin.on('error', () => {})
    proc.stdout.on('data', chunk => chunks.push(chunk))
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000) })
    proc.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    proc.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    })
    proc.stdin.end(input)
  })
}

export async function hlsToMp3(url) {
  const { map, segments } = await loadPlaylist(url)
  const parts = await fetchSegments(segments)
  if (map) parts.unshift(await getBuffer(map))
  return toMp3(Buffer.concat(parts))
}

export async function search(query) {
  const params = new URLSearchParams({ q: query, client_id: 'KKzJxmw11tYpCs6T24P4uUYhqmjalG6M', stage: '' })
  const res = await fetch(`https://api-mobi.soundcloud.com/search?${params}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*; q=0.1',
      'Content-Type': 'application/json'
    }
  })
  if (!res.ok) throw new Error(`Search failed with status ${res.status}`)

  const data = await res.json()
  return (data.collection || [])
    .filter(item => item.kind === 'track')
    .map(item => ({
      id: item.id,
      title: item.title || null,
      artist: item.user?.username || null,
      duration_sec: Math.round((item.duration || 0) / 1000),
      playback_count: item.playback_count ?? null,
      permalink_url: item.permalink_url
    }))
}
