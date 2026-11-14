const tv = {
  playlistUrl: 'https://iptv-org.github.io/iptv/index.m3u',
  playlistTtlMs: 6 * 60 * 60 * 1000,
  playlistTimeoutMs: 30 * 1000,
  probeTimeoutMs: 15 * 1000,
  maxNameLength: 70,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
}

function squash(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function parsePlaylist(text) {
  const channels = []
  let info = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) {
      info = line
    } else if (info !== null && /^https?:\/\//i.test(line)) {
      const name = info.slice(info.lastIndexOf(',') + 1).trim() || 'Unknown'
      const tvgId = /tvg-id="([^"]*)"/i.exec(info)?.[1] || ''
      const country = /\.([a-z]{2})@/i.exec(tvgId)?.[1]?.toLowerCase() || 'xx'
      channels.push({ name: name.slice(0, tv.maxNameLength), key: squash(name), country, url: line })
      info = null
    }
  }
  return channels
}

async function loadChannels() {
  const cached = global.waTvPlaylist
  if (cached && Date.now() - cached.at < tv.playlistTtlMs) return cached.channels
  const res = await fetch(tv.playlistUrl, {
    headers: { 'User-Agent': tv.userAgent, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(tv.playlistTimeoutMs)
  }).catch(() => null)
  if (!res?.ok) throw new Error('Failed to load the channel list. Try again later.')
  const channels = parsePlaylist(await res.text())
  if (!channels.length) throw new Error('The channel list is empty.')
  global.waTvPlaylist = { at: Date.now(), channels }
  return channels
}

function channelVersion() {
  return global.waTvPlaylist?.at || 0
}

function pickChannel(version, index) {
  const cached = global.waTvPlaylist
  if (!cached || String(cached.at) !== String(version)) throw new Error('This list has expired. Send the TV list again.')
  const channel = cached.channels[Number(index)]
  if (!channel) throw new Error('Channel not found in the list.')
  return channel
}

function findChannel(channels, query) {
  const wanted = squash(query)
  if (!wanted) return null
  return channels.find(channel => channel.key === wanted)
    || channels.find(channel => channel.key.startsWith(wanted))
    || channels.find(channel => channel.key.includes(wanted))
    || null
}

async function resolveChannel(query) {
  if (/^https?:\/\/\S+$/i.test(query)) return { name: query.slice(0, tv.maxNameLength), key: '', country: 'xx', url: query }
  const channel = findChannel(await loadChannels(), query)
  if (!channel) throw new Error(`No channel found for "${query}".`)
  return channel
}

async function probeStream(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': tv.userAgent, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(tv.probeTimeoutMs)
    })
    try {
      await res.body?.cancel()
    } catch {}
    return res.ok
  } catch {
    return false
  }
}

export { loadChannels, channelVersion, pickChannel, resolveChannel, probeStream }
