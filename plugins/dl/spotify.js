import axios from "axios";
import { URL_REGEX } from 'baileys';

let handler = async(m, { conn, usedPrefix, command, text }) => {
    let chat = db.data.chats[m.chat]
    if (!text) return m.reply(`> *SEARCH -* [ ${usedPrefix + command} <Music_name> ]\n> *DOWNLOAD -* [ ${usedPrefix + command} <Spotify_link> ]\n> *PLAYER  -* add *--html* at the end for the interactive player view`)

    const htmlMode = /(^|\s)--html(\s|$)/i.test(text)
    text = text.replace(/--html/gi, '').trim()
    if (!text) return m.reply(`> Please provide a song title or a Spotify link too.\n> Example: ${usedPrefix + command} shape of you --html`)

    const pickMatch = text.match(/^--pick\s+(\S+)$/i)
    if (pickMatch) {
        let track
        try {
            track = JSON.parse(Buffer.from(pickMatch[1], 'base64').toString('utf8'))
        } catch (err) {
            return m.reply("- Failed to get song data.\n- Debug: invalid payload")
        }

        let result
        try {
            result = await spotifyDownloadByTrack(track.t, track.a, track.al, track.c)
        } catch (err) {
            return m.reply(`- Failed to get song data.\n- Debug: ${err.message}`)
        }

        return sendTrackResult(m, conn, chat, result)
    }

    if (htmlMode) {
        return text.match(URL_REGEX)
            ? sendHtmlTrackPlayer(m, conn, text)
            : sendHtmlSearchPlayer(m, conn, text)
    }

    if (!text.match(URL_REGEX)) {
        const res = await searchSpotify(text)
        if (!res?.success || !res?.results?.length) return m.reply("- *Error:* " + res.message)

        const rows = res.results.map((v, i) => {
            const payload = Buffer.from(JSON.stringify({
                t : v.title,
                a : v.artists.join(', '),
                al: v.album?.name || null,
                c : v.album?.cover || null
            }), 'utf8').toString('base64')

            return {
                header     : `${v.title}`,
                title      : `Artist: ${v.artists.join(', ')}  •  Duration: ${v.duration}`,
                description: `📁 ${v.album?.name || 'Unknown Album'}`,
                id         : `${usedPrefix}spotify --pick ${payload}`
            }
        })

        const coverUrl = res.results[0].album?.cover || 'https://i.scdn.co/image/ab67616d0000b273';

        let thumb
        try {
            const thumbResp = await axios.get(coverUrl, { responseType: 'arraybuffer' });
            thumb = await conn.resize(Buffer.from(thumbResp.data), 100, 100);
        } catch {
            thumb = undefined
        }

        const payload = {
            document   : { url: coverUrl },
            mimetype   : 'image/webp',
            caption    : " ",
            fileName   : 'SPOTIFY SEARCH',
            fileLength : '665666646645000',
            nativeFlow : [
                { text: 'Select', sections: [{ title: 'Result', rows }] }
            ],
        }
        if (thumb) payload.jpegThumbnail = thumb

        return conn.sendButton(m.chat, payload, m)

    } else {
        if (!/open\.spotify\.com/i.test(text)) {
            return m.reply("- Only support Spotify link.")
        }

        let result
        try {
            result = await spotifyDownloadByUrl(text)
        } catch (err) {
            return m.reply(`- Failed to get song data.\n- Debug: ${err.message}`)
        }

        if (!result) {
            return m.reply("- Failed to get song data.\n- Debug: track not found on spotsaver.net")
        }

        return sendTrackResult(m, conn, chat, result)
    }
}

async function sendTrackResult(m, conn, chat, result) {
    const { metadata, links } = result

    const trackName = metadata.name || 'Unknown Title'
    const coverUrl  = links.cover || metadata.cover || null
    const audioUrl  = links.mp3

    if (!audioUrl) {
        return m.reply("- Failed to get song data.\n- Debug: mp3 link is empty, check the console log.")
    }

    let thumbBuffer
    if (coverUrl) {
        try {
            const coverResp = await axios.get(coverUrl, { responseType: 'arraybuffer' });
            thumbBuffer = await conn.resize(Buffer.from(coverResp.data), 150, 150);
        } catch {
            thumbBuffer = undefined
        }
    }

    return conn.sendFile(m.chat, audioUrl, `${trackName}.mp3`, '', m, false, {
        mimetype: 'audio/mpeg',
        asDocument: chat.useDocument,
        quoted: { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: thumbBuffer, itemCount: 666, status: 1, surface: 1, message: trackName, orderTitle: trackName, sellerJid: '0@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } }
    })
}

handler.tags    = ["downloader"]
handler.help    = ["spotify <name/link>"]
handler.command = ["spotify"]
handler.ai      = { risk:"low", description:"search/download spotify music" }

export default handler

const BASE        = "https://spotsaver.net"
const YTM_API     = "https://music.youtube.com/youtubei/v1/search"
const YTM_KEY     = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30"
const YTM_VERSION = "1.20260915.14.00"
const Y2MATE_API  = "https://eta.etacloud.org"
const Y2MATE_KEY  = "c6a644f406b57d0dd83837c868a7482e"
const UA          = "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

function proxyUrl(apiBase, rawUrl, referer) {
    if (!rawUrl) return null
    if (!apiBase) return rawUrl
    let out = `${apiBase}/api/proxy?url=${encodeURIComponent(rawUrl)}`
    if (referer) out += `&ref=${encodeURIComponent(referer)}`
    return out
}

const client = axios.create({
  timeout: 90000,
  headers: {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    "Referer": BASE + "/id/",
    "Origin": BASE
  },
  validateStatus: s => s < 600,
  transformResponse: [v => v]
})

const y2mateClient = axios.create({
  timeout: 90000,
  headers: {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://y2mate.gs",
    "Referer": "https://y2mate.gs/"
  },
  validateStatus: s => s < 600,
  transformResponse: [v => v]
})


// ─── Audio over WebSocket ────────────────────────────────────────────────────
// The rich-message WebView runs in a sandbox (origin=null): fetch() and <audio src=http...>
// requests TO OUR OWN SERVER ARE BLOCKED (confirmed via .audiotest: fetch/proxy tests failed),
// while WebSocket works and <audio> with a Blob/data-URI plays fine (data-URI/Blob tests passed).
// So: the server downloads the mp3 itself, the client pulls it in chunks over WebSocket
// (the same aiRichAction channel the Download button uses), then feeds it to <audio>.
const AUDIO_CHUNK_BYTES = 192 * 1024              // 192KB -> ~256KB base64 per WS message
const AUDIO_CACHE_TTL   = 20 * 60 * 1000
const AUDIO_CACHE_MAX   = 6
const AUDIO_MAX_BYTES   = 25 * 1024 * 1024
const audioCache = new Map()                      // rawUrl -> { buf, mime, expiresAt } or { pending }

function pruneAudioCache() {
    const now = Date.now()
    for (const [k, v] of audioCache) if (v.expiresAt && now > v.expiresAt) audioCache.delete(k)
    while (audioCache.size > AUDIO_CACHE_MAX) audioCache.delete(audioCache.keys().next().value)
}

async function loadAudioBuffer(rawUrl) {
    pruneAudioCache()
    const hit = audioCache.get(rawUrl)
    if (hit?.buf) { hit.expiresAt = Date.now() + AUDIO_CACHE_TTL; return hit }
    if (hit?.pending) return hit.pending

    const pending = (async () => {
        const res = await axios.get(rawUrl, {
            responseType: 'arraybuffer',
            timeout: 120000,
            maxContentLength: AUDIO_MAX_BYTES,
            maxBodyLength: AUDIO_MAX_BYTES,
            headers: { 'User-Agent': UA },
            validateStatus: s => s < 600
        })
        if (res.status >= 400) throw new Error('Audio download failed: HTTP ' + res.status)
        const buf = Buffer.from(res.data)
        if (!buf.length) throw new Error('Audio download failed: empty file')
        const head = buf.subarray(0, 64).toString('latin1')
        if (/^\s*(<!doctype|<html|\{)/i.test(head)) throw new Error('Audio download failed: response is not audio')
        const entry = { buf, mime: 'audio/mpeg', expiresAt: Date.now() + AUDIO_CACHE_TTL }
        audioCache.set(rawUrl, entry)
        return entry
    })()
    audioCache.set(rawUrl, { pending })
    try { return await pending } catch (e) { audioCache.delete(rawUrl); throw e }
}

// Called by the WS action: { op:'meta' } -> size & chunk count, { op:'chunk', n } -> base64 data
async function serveAudioChunk(rawUrl, args) {
    const entry = await loadAudioBuffer(rawUrl)
    const total = Math.ceil(entry.buf.length / AUDIO_CHUNK_BYTES)
    if (args?.op === 'chunk') {
        const n = Number(args.n)
        if (!Number.isInteger(n) || n < 0 || n >= total) throw new Error('Chunk out of range')
        const part = entry.buf.subarray(n * AUDIO_CHUNK_BYTES, (n + 1) * AUDIO_CHUNK_BYTES)
        return { n, total, data: part.toString('base64') }
    }
    return { size: entry.buf.length, total, mime: entry.mime }
}


// Album cover: <img src=http> is blocked by the WebView sandbox too -> send it as a data-URI over WS.
const coverCache = new Map()
async function fetchCoverDataUri(url) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Invalid cover URL')
    if (coverCache.has(url)) return coverCache.get(url)
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 3 * 1024 * 1024, headers: { 'User-Agent': UA }, validateStatus: s => s < 600 })
    if (res.status >= 400) throw new Error('Cover HTTP ' + res.status)
    const buf = Buffer.from(res.data)
    const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    const mime = /^image\//.test(ct) ? ct : (/\.png(\?|$)/i.test(url) ? 'image/png' : 'image/jpeg')
    const uri = `data:${mime};base64,${buf.toString('base64')}`
    if (coverCache.size >= 40) coverCache.delete(coverCache.keys().next().value)
    coverCache.set(url, uri)
    return uri
}

function parseJson(d) {
  if (typeof d === "string") { try { return JSON.parse(d) } catch (_) { return null } }
  return d
}

function pickTrack(t) {
  if (!t) return null
  return {
    id: t.id ?? null,
    title: t.title ?? null,
    artist: t.artist ?? null,
    album: t.album ?? null,
    duration: t.duration ?? null,
    thumbnail: t.thumbnail ?? null,
    previewUrl: t.previewUrl ?? t.preview_url ?? null,
    spotifyUrl: t.id ? "https://open.spotify.com/track/" + t.id : null
  }
}

async function spotsaverSearch(q) {
  if (!q) throw new Error("Empty query")
  const r = await client.get(BASE + "/api/spotify", { params: { q } })
  const d = parseJson(r.data)
  if (r.status >= 400 || !d?.items) throw new Error("Search failed: HTTP " + r.status)
  return { query: q, type: d.type || "search", count: d.items.length, items: d.items.map(pickTrack) }
}

async function spotsaverInfo(url) {
  if (!url) throw new Error("Empty URL")
  const r = await client.get(BASE + "/api/spotify", { params: { url } })
  const d = parseJson(r.data)
  if (r.status >= 400 || !d?.items) throw new Error("Info request failed: HTTP " + r.status)
  return { type: d.type, url, count: d.items.length, items: d.items.map(pickTrack) }
}

async function ytmSearch(query) {
  const body = {
    context: { client: { clientName: "WEB_REMIX", clientVersion: YTM_VERSION, hl: "id", gl: "ID" } },
    query,
    params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"
  }
  const r = await axios.post(YTM_API + "?key=" + YTM_KEY + "&prettyPrint=false", body, {
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "X-Goog-Api-Key": YTM_KEY,
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": YTM_VERSION,
      "Origin": "https://music.youtube.com",
      "Referer": "https://music.youtube.com/"
    },
    timeout: 20000,
    validateStatus: s => s < 600,
    transformResponse: [v => v]
  })
  let d = r.data
  if (typeof d === "string") { try { d = JSON.parse(d) } catch (_) {} }
  const out = []
  const tabs = d?.contents?.tabbedSearchResultsRenderer?.tabs || []
  for (const tab of tabs) {
    const secs = tab?.tabRenderer?.content?.sectionListRenderer?.contents || []
    for (const sec of secs) {
      const shelf = sec.musicShelfRenderer
      if (!shelf) continue
      for (const it of shelf.contents || []) {
        const item = it.musicResponsiveListItemRenderer
        if (!item) continue
        const vid = item?.playlistItemData?.videoId || null
        const flexTexts = (item.flexColumns || []).map(col => {
          const runs = col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
          return runs.map(x => x.text).join("").trim()
        }).filter(Boolean)
        const thumb = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
        const image = Array.isArray(thumb) && thumb.length ? thumb[thumb.length - 1].url : null
        if (vid && flexTexts[0]) {
          out.push({
            videoId: vid,
            title: flexTexts[0],
            subtitle: flexTexts[1] || null,
            thumbnail: image
          })
        }
      }
    }
  }
  return out
}

async function y2mateAuth() {
  const r = await y2mateClient.get(Y2MATE_API + "/api/v1/auth", {
    params: { api_key: Y2MATE_KEY, _: Date.now() }
  })
  const d = parseJson(r.data)
  if (!d?.key) throw new Error("y2mate auth failed: " + JSON.stringify(d).slice(0, 200))
  return d.key
}

async function y2mateInit(key) {
  const r = await y2mateClient.get(Y2MATE_API + "/api/v1/init", {
    params: { _: Date.now() },
    headers: { Authorization: "Bearer " + key }
  })
  const d = parseJson(r.data)
  if (!d?.convertURL) throw new Error("y2mate init failed: " + JSON.stringify(d).slice(0, 200))
  return d
}

async function y2mateConvert(url, videoId) {
  const base = url.split("&v=")[0]
  const r = await y2mateClient.get(base, { params: { v: videoId, f: "mp3", _: Date.now() } })
  const d = parseJson(r.data)
  if (!d) throw new Error("y2mate convert invalid response")
  if (Number(d.error) > 0) throw new Error("y2mate convert error: " + d.error)
  return d
}

async function y2mateProgress(progressUrl) {
  const r = await y2mateClient.get(progressUrl, { params: { _: Date.now() } })
  const d = parseJson(r.data)
  if (!d) throw new Error("y2mate progress invalid response")
  if (Number(d.error) > 0) throw new Error("y2mate progress error: " + d.error)
  return d
}

async function y2mateGetMp3(videoId) {
  const auth = await y2mateAuth()
  const init = await y2mateInit(auth)
  let currentUrl = init.convertURL
  let downloadURL = null
  let progressURL = null

  for (let i = 0; i < 20; i++) {
    const d = await y2mateConvert(currentUrl, videoId)
    if (d.downloadURL) { downloadURL = d.downloadURL; break }
    if (d.progressURL) progressURL = d.progressURL
    if (d.redirectURL) {
      currentUrl = d.redirectURL
      await new Promise(x => setTimeout(x, 1500))
      continue
    }
    break
  }

  if (!downloadURL && progressURL) {
    for (let i = 0; i < 30; i++) {
      await new Promise(x => setTimeout(x, 3000))
      const d = await y2mateProgress(progressURL)
      if (d.downloadURL) { downloadURL = d.downloadURL; break }
      if (d.redirectURL) {
        const rd = await y2mateConvert(d.redirectURL, videoId)
        if (rd.downloadURL) { downloadURL = rd.downloadURL; break }
        if (rd.progressURL) progressURL = rd.progressURL
      }
      if (Number(d.progress) >= 3) break
    }
  }

  if (!downloadURL) throw new Error("y2mate: downloadURL not found")
  return downloadURL + "&v=" + videoId + "&f=mp3&r=y2mate.gs"
}

const searchCache = new Map();
const pendingSearches = new Map();
const SEARCH_CACHE_TTL = 30_000;

async function searchSpotify(query) {
    const normalizedQuery = String(query || "").trim();

    if (!normalizedQuery) {
        return { success: false, message: "Search query must not be empty" };
    }

    const cacheKey = normalizedQuery.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.result;
    }

    if (pendingSearches.has(cacheKey)) {
        return pendingSearches.get(cacheKey);
    }

    const searchPromise = (async () => {
        try {
            const { items } = await spotsaverSearch(normalizedQuery);

            const results = items.map(v => ({
                id: v.id || null,
                title: v.title || 'Unknown Title',
                artists: v.artist ? [v.artist] : [],
                durationMs: null,
                duration: v.duration || '0:00',
                album: {
                    name: v.album || null,
                    cover: v.thumbnail || null
                }
            })).filter(v => v.title && v.title !== 'Unknown Title');

            const result = {
                success: results.length > 0,
                total: results.length,
                results,
                message: results.length ? undefined : 'No results found'
            };

            searchCache.set(cacheKey, {
                result,
                expiresAt: Date.now() + SEARCH_CACHE_TTL
            });

            return result;
        } catch (error) {
            return {
                success: false,
                message: error.message || "Failed to search for songs"
            };
        } finally {
            pendingSearches.delete(cacheKey);
        }
    })();

    pendingSearches.set(cacheKey, searchPromise);
    return searchPromise;
}

async function spotifyDownloadByTrack(title, artist, album, thumbnail) {
    const searchQuery = title + (artist ? ' ' + artist : '');
    const yt = await ytmSearch(searchQuery);
    if (!yt.length) throw new Error('No results on YouTube Music');
    const top = yt[0];

    const mp3Url = await y2mateGetMp3(top.videoId);

    return {
        metadata: {
            name: title,
            artist: artist || null,
            album: album || null,
            cover: thumbnail || null
        },
        links: {
            mp3: mp3Url,
            cover: thumbnail || null
        }
    };
}

async function spotifyDownloadByUrl(spotifyUrl) {
    const info = await spotsaverInfo(spotifyUrl.split('?')[0]);
    const track = info.items[0];
    if (!track) return null;

    return spotifyDownloadByTrack(track.title, track.artist, track.album, track.thumbnail);
}

async function sendHtmlTrackPlayer(m, conn, spotifyUrl) {
    await m.reply('🔎 Fetching song data...')

    let result
    try {
        result = await spotifyDownloadByUrl(spotifyUrl)
    } catch (err) {
        throw `- Failed to get song data.\n- Debug: ${err.message}`
    }
    if (!result?.links?.mp3) throw '- Failed to get song data.\n- Debug: mp3 link is empty / track not found.'

    const { metadata, links } = result
    const rawAudioUrl = links.mp3
    const rawCoverUrl = links.cover || metadata.cover || null
    const trackTitle  = metadata.name || 'Unknown Title'

    const apiBase = (typeof global.opts?.server === 'string' ? global.opts.server : '').replace(/\/$/, '')
    const httpsApiBase = apiBase ? apiBase.replace(/^http:\/\//, 'https://') : ''
    const apiHost = httpsApiBase.replace(/^https?:\/\//, '')

    const track = {
        title: trackTitle,
        artists: metadata.artist ? [metadata.artist] : [],
        album: { cover: proxyUrl(httpsApiBase, rawCoverUrl) },
        audioUrl: 'ws',
    }

    const downloadToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId) => {
            await conn.sendFile(chatId, rawAudioUrl, `${trackTitle}.mp3`, '', null, false, { mimetype: 'audio/mpeg' })
            return { message: 'Sent to chat.' }
        }
    })

    const audioToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => serveAudioChunk(rawAudioUrl, args)
    })

    const coverToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async () => ({ dataUri: await fetchCoverDataUri(rawCoverUrl) })
    })

    const rich = conn.aiRich().setTitle('Spotify Player')
    rich.addHtml(
        buildSpotifyPlayerHtml({ tracks: [track], downloadToken, resolveToken: null, audioToken, coverToken, apiBase: httpsApiBase, single: true }),
        { trustedSources: apiHost ? [apiHost] : [] }
    )
    await rich.send(m.chat, { quoted: m })
}

async function sendHtmlSearchPlayer(m, conn, query) {
    const res = await searchSpotify(query)
    if (!res?.success || !res?.results?.length) throw '- *Error:* ' + (res?.message || 'No results found')

    const apiBase = (typeof global.opts?.server === 'string' ? global.opts.server : '').replace(/\/$/, '')
    const httpsApiBase = apiBase ? apiBase.replace(/^http:\/\//, 'https://') : ''
    const apiHost = httpsApiBase.replace(/^https?:\/\//, '')

    const rawTracks = res.results.slice(0, 8).map(v => ({
        title: v.title,
        artists: v.artists,
        albumName: v.album?.name || null,
        rawCover: v.album?.cover || null,
        rawAudioUrl: null,
    }))

    const tracks = rawTracks.map(t => ({
        title: t.title,
        artists: t.artists,
        album: { cover: proxyUrl(httpsApiBase, t.rawCover) },
        audioUrl: null,
    }))

    const resolveToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
            const i = Number(args?.index) || 0
            const rt = rawTracks[i]
            if (!rt) throw new Error('Track not found.')
            if (!rt.rawAudioUrl) {
                if (!rt._pending) {
                    rt._pending = spotifyDownloadByTrack(rt.title, rt.artists.join(', '), rt.albumName, rt.rawCover)
                        .finally(() => { rt._pending = null })
                }
                const result = await rt._pending
                if (!result?.links?.mp3) throw new Error('Audio link unavailable for this track.')
                rt.rawAudioUrl = result.links.mp3
                if (!rt.rawCover) rt.rawCover = result.links.cover || result.metadata?.cover || null
            }
            return { audioUrl: 'ws', cover: null }
        }
    })

    const audioToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
            const i = Number(args?.index) || 0
            const rt = rawTracks[i]
            if (!rt?.rawAudioUrl) throw new Error('Track is not ready yet, press play first.')
            return serveAudioChunk(rt.rawAudioUrl, args)
        }
    })

    const coverToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
            const rt = rawTracks[Number(args?.index) || 0]
            if (!rt?.rawCover) throw new Error('This track has no cover.')
            return { dataUri: await fetchCoverDataUri(rt.rawCover) }
        }
    })

    const downloadToken = global.registerHtmlAction({
        chatId: m.chat,
        singleUse: false,
        run: async (conn, chatId, args) => {
            const i = Number(args?.index) || 0
            const rt = rawTracks[i]
            if (!rt?.rawAudioUrl) throw new Error('Track is not ready yet, please wait a moment and try again.')
            await conn.sendFile(chatId, rt.rawAudioUrl, `${rt.title}.mp3`, '', null, false, { mimetype: 'audio/mpeg' })
            return { message: 'Sent to chat.' }
        }
    })

    const rich = conn.aiRich()
        .setTitle('Spotify Search')
        .addSuggest([`Query: ${query}`, `Result: ${tracks.length}`])

    rich.addHtml(
        buildSpotifyPlayerHtml({ tracks, downloadToken, resolveToken, audioToken, coverToken, apiBase: httpsApiBase, single: false }),
        { trustedSources: apiHost ? [apiHost] : [] }
    )
    await rich.send(m.chat, { quoted: m })
}

function buildSpotifyPlayerHtml({ tracks, downloadToken, resolveToken, audioToken, coverToken, apiBase, single }) {
    const httpsApiBase = apiBase ? apiBase.replace(/^http:\/\//, 'https://') : ''
    const wsUrl = httpsApiBase ? httpsApiBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') : ''
    const fallbackCover = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#282828"/><path d="M40 30v28.5a9 9 0 1 0 4 7.46V42l24-5v18.5a9 9 0 1 0 4 7.46V25z" fill="#535353"/></svg>'
    )

    return `<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
body{margin:0;background:transparent;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;touch-action:manipulation}
.wrap{width:100%;max-width:400px;margin:auto;padding:14px}
.card{background:linear-gradient(180deg,#3a3a3a 0%,#121212 45%);border-radius:20px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5);padding:20px}
.brand{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:1px;color:#1DB954;margin-bottom:14px}
.brand svg{width:18px;height:18px;flex:none}
.cover-wrap{position:relative;width:100%;height:0;padding-top:100%;border-radius:12px;overflow:hidden;background:#282828;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.cover-wrap img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block}
.spinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;border:3px solid rgba(255,255,255,.25);border-top-color:#1DB954;border-radius:50%;animation:spin .8s linear infinite;display:none}
@keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
.meta{margin-top:16px;text-align:center}
.meta .title{font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .artist{font-size:13px;color:#b3b3b3;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress{margin-top:16px;display:flex;align-items:center;gap:8px}
.progress input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:#4d4d4d;outline:none}
.progress input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#fff;cursor:pointer}
.progress span{font-size:10px;color:#b3b3b3;min-width:32px;text-align:center}
.controls{display:flex;align-items:center;justify-content:center;gap:26px;margin-top:10px}
.ctrl{background:none;border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.9}
.ctrl svg{width:22px;height:22px;fill:#fff}
.ctrl.play{width:56px;height:56px;border-radius:50%;background:#1DB954;box-shadow:0 4px 14px rgba(29,185,84,.4)}
.ctrl.play svg{width:24px;height:24px}
.ctrl:disabled{opacity:.3;cursor:default}
.bottom{margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.counter{font-size:11px;color:#777}
.dl{background:none;border:1px solid rgba(255,255,255,.25);border-radius:16px;color:#fff;font-size:12px;font-weight:600;padding:6px 14px;cursor:pointer}
.dl:disabled{opacity:.5}
</style>
<div class="wrap">
  <div class="card">
    <div class="brand">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1DB954"/><path d="M17.5 16.2c-.2.3-.6.4-.9.2-2.5-1.5-5.6-1.9-9.3-1-.4.1-.7-.1-.8-.5-.1-.4.1-.7.5-.8 4-.9 7.5-.5 10.3 1.2.3.2.4.6.2.9zm1.2-2.7c-.3.4-.7.5-1.1.3-2.9-1.8-7.3-2.3-10.7-1.3-.4.1-.9-.1-1-.5-.1-.4.1-.9.5-1 3.9-1.2 8.7-.6 12 1.5.4.2.5.7.3 1zm.1-2.8C15.4 8.6 9.1 8.4 5.5 9.5c-.5.2-1.1-.1-1.2-.6-.2-.5.1-1.1.6-1.2 4.2-1.3 11.1-1 15.1 1.3.5.3.6.9.3 1.4-.3.4-.9.5-1.4.2z" fill="#000"/></svg>
      SPOTIFY
    </div>
    <div class="cover-wrap">
      <img id="cover" src="${fallbackCover}">
      <div class="spinner" id="spinner"></div>
    </div>
    <div class="meta">
      <div class="title" id="title">Loading…</div>
      <div class="artist" id="artist">&nbsp;</div>
    </div>
    <div class="progress">
      <span id="curTime">0:00</span>
      <input type="range" id="seek" value="0" min="0" max="100" step="0.1">
      <span id="durTime">0:00</span>
    </div>
    <div class="controls">
      <button class="ctrl" id="prev" ${single ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
      </button>
      <button class="ctrl play" id="playBtn">
        <svg id="playIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl" id="next" ${single ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg>
      </button>
    </div>
    <div class="bottom">
      <span class="counter" id="counter"></span>
      <button class="dl" id="dl">Download</button>
    </div>
  </div>
</div>
<audio id="audio" preload="none"></audio>
<script>
const tracks = ${JSON.stringify(tracks)};
const downloadToken = ${JSON.stringify(downloadToken || '')};
const resolveToken = ${JSON.stringify(resolveToken || '')};
const audioToken = ${JSON.stringify(audioToken || '')};
const coverToken = ${JSON.stringify(coverToken || '')};
const apiBase = ${JSON.stringify(httpsApiBase)};
const single = ${JSON.stringify(!!single)};
let idx = 0;
let loading = false;

const coverEl = document.getElementById('cover');
const coverCacheC = new Map();          // index -> data URI
let coverReq = 0;
async function loadCover(i){
  const t = tracks[i];
  if (!t || !coverToken) return;
  if (coverCacheC.has(i)) { if (idx === i) coverEl.src = coverCacheC.get(i); return; }
  const my = ++coverReq;
  const r = await sendAction({ type:'aiRichAction', token: coverToken, index: i }, 20000);
  if (r.success && r.dataUri) {
    coverCacheC.set(i, r.dataUri);
    if (idx === i && my === coverReq) coverEl.src = r.dataUri;
  }
}
const spinnerEl = document.getElementById('spinner');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const counterEl = document.getElementById('counter');
const seekEl = document.getElementById('seek');
const curTimeEl = document.getElementById('curTime');
const durTimeEl = document.getElementById('durTime');
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const dlBtn = document.getElementById('dl');
const audioEl = document.getElementById('audio');

const PLAY_SVG = 'M8 5v14l11-7z';
const PAUSE_SVG = 'M6 5h4v14H6zm8 0h4v14h-4z';

function fmt(sec){
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return m + ':' + String(s).padStart(2,'0');
}

function renderMeta(){
  const t = tracks[idx];
  titleEl.textContent = t.title;
  artistEl.textContent = (t.artists||[]).join(', ') || ' ';
  counterEl.textContent = single ? '' : ((idx+1) + ' / ' + tracks.length);
  coverEl.src = coverCacheC.get(idx) || '${fallbackCover}';
  loadCover(idx);
}

let ws = null, wsReady = false, pingTimer = null;
const pending = new Map();
function connectWs(){
  if (!apiBase) return;
  try { ws = new WebSocket(apiBase.replace(/^https:/,'wss:').replace(/^http:/,'ws:')); } catch(e){ return; }
  ws.onopen = () => {
    wsReady = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState===1) ws.send(JSON.stringify({type:'ping'})); }, 10000);
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'aiRichActionResult' && pending.has(msg.requestId)) {
      pending.get(msg.requestId)(msg);
      pending.delete(msg.requestId);
    }
  };
  ws.onclose = () => { wsReady = false; if (pingTimer) clearInterval(pingTimer); setTimeout(connectWs, 1500); };
  ws.onerror = () => { wsReady = false; };
}
connectWs();

// Wait for the WebSocket to be truly OPEN (page just opened / reconnecting) before giving up.
function waitWsOpen(maxMs){
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll(){
      if (ws && ws.readyState === 1) return resolve(true);
      if (Date.now() - start >= maxMs) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

async function sendAction(payload, timeoutMs = 15000){
  if (!(await waitWsOpen(8000))) return { success:false, message:'Not connected to the bot server (WebSocket)' };
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ success:false, message:'Connection lost' });
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { pending.delete(requestId); resolve({success:false,message:'Timed out'}); }, timeoutMs);
    pending.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
    try { ws.send(JSON.stringify({ ...payload, requestId })); }
    catch (e) { clearTimeout(timer); pending.delete(requestId); resolve({ success:false, message:'Failed to send: ' + (e && e.message) }); }
  });
}

function showError(msg){
  artistEl.textContent = msg;
}

function attemptPlay(){
  const p = audioEl.play();
  if (p && typeof p.catch === 'function') {
    p.catch(err => showError('Playback failed: ' + (err?.name || 'unknown') + (err?.message ? ' — ' + err.message : '')));
  }
}

// ── Fetch audio over WebSocket, assemble into a Blob URL ────────────────────────────
// fetch()/<audio src=http> to the server is restricted by the WebView sandbox (origin=null);
// WebSocket and Blob/data-URI are not. The server splits the mp3 into base64 chunks and the client reassembles them here.
const blobCache = new Map();          // track index -> blob URL (no need to re-download on prev/next)

function b64ToBytes(b64){
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Fetch 1 chunk with retries. Returns a Uint8Array or throws an Error.
async function getChunk(trackIndex, n){
  let res = null;
  for (let attempt = 0; attempt < 3 && !(res && res.success); attempt++) {
    res = await sendAction({ type:'aiRichAction', token: audioToken, index: trackIndex, op:'chunk', n }, 30000);
  }
  if (!res || !res.success) throw new Error((res && res.message) || ('Chunk ' + n + ' failed'));
  return b64ToBytes(res.data);
}

// Download ALL chunks and turn them into a Blob. Used as a fallback when MSE is unavailable / fails.
async function fetchAudioBlobUrl(trackIndex, onProgress){
  if (blobCache.has(trackIndex)) return { ok: true, url: blobCache.get(trackIndex) };
  if (!audioToken) return { ok: false, message: 'Audio token is not available' };

  const meta = await sendAction({ type:'aiRichAction', token: audioToken, index: trackIndex, op:'meta' }, 100000);
  if (!meta.success) return { ok: false, message: meta.message || 'Failed to get audio info' };

  const parts = new Array(meta.total);
  let done = 0, next = 0, failed = null;
  async function worker(){
    while (failed === null) {
      const n = next++;
      if (n >= meta.total) return;
      try { parts[n] = await getChunk(trackIndex, n); }
      catch (e) { failed = e.message; return; }
      done++;
      if (onProgress) onProgress(done, meta.total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, meta.total) }, worker));
  if (failed !== null) return { ok: false, message: failed };

  const url = URL.createObjectURL(new Blob(parts, { type: meta.mime || 'audio/mpeg' }));
  blobCache.set(trackIndex, url);
  return { ok: true, url };
}

// ── STREAMING via MediaSource ────────────────────────────────────────────────────────
// The song starts playing after the first few chunks; the rest arrive while it plays.
// Confirmed supported by this WebView (audiotest T4/T5). If anything fails -> fall back to Blob.
const MSE_START_CHUNKS = 2;             // start playing once 2 chunks (~384 KB) are in
const MSE_PARALLEL = 3;                 // download 3 chunks at once, but append them IN ORDER
let streamSession = 0;                  // bumped on every track change -> the old session stops by itself

function mseSupported(){
  try { return !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported('audio/mpeg')); }
  catch (e) { return false; }
}

// Returns { ok, url?, stream:true, cancelled?, message?, mseFailed? }.
// onReady is called as soon as enough chunks are in to start playback.
async function streamAudio(trackIndex, onProgress, onReady){
  if (!audioToken) return { ok: false, message: 'Audio token is not available' };
  const session = ++streamSession;
  streamBytesIn = 0;
  const alive = () => session === streamSession;

  const meta = await sendAction({ type:'aiRichAction', token: audioToken, index: trackIndex, op:'meta' }, 100000);
  if (!meta.success) return { ok: false, message: meta.message || 'Failed to get audio info' };
  if (!alive()) return { ok: false, cancelled: true };

  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  try {
    // src must be set before 'sourceopen' fires
    audioEl.src = url;
    await new Promise((res, rej) => {
      ms.addEventListener('sourceopen', res, { once: true });
      setTimeout(() => rej(new Error('sourceopen timeout')), 8000);
    });
    const sb = ms.addSourceBuffer('audio/mpeg');

    // appendBuffer must not be called while the buffer is still 'updating' -> wait for updateend each time
    const append = (bytes) => new Promise((res, rej) => {
      const ok = () => { sb.removeEventListener('error', bad); res(); };
      const bad = () => { sb.removeEventListener('updateend', ok); rej(new Error('appendBuffer error')); };
      sb.addEventListener('updateend', ok, { once: true });
      sb.addEventListener('error', bad, { once: true });
      try { sb.appendBuffer(bytes); } catch (e) { sb.removeEventListener('updateend', ok); sb.removeEventListener('error', bad); rej(e); }
    });

    // download in parallel, append IN ORDER. Downloads may not run ahead of the append point by more than a fixed window.
    const got = new Map();               // n -> Uint8Array downloaded but not yet appended
    let nextFetch = 0, nextAppend = 0, failed = null, readyCalled = false;
    const waiters = [];
    const wake = () => { while (waiters.length) waiters.shift()(); };

    async function fetcher(){
      while (failed === null && alive()) {
        if (nextFetch >= meta.total) return;
        if (nextFetch - nextAppend >= MSE_PARALLEL + 1) { await new Promise(r => { waiters.push(r); setTimeout(r, 500); }); continue; }
        const n = nextFetch++;
        try { got.set(n, await getChunk(trackIndex, n)); }
        catch (e) { failed = e.message; wake(); return; }
        wake();
      }
    }
    const fetchers = Array.from({ length: Math.min(MSE_PARALLEL, meta.total) }, fetcher);

    while (nextAppend < meta.total) {
      if (!alive()) return { ok: false, cancelled: true };
      if (failed !== null) throw new Error(failed);
      if (!got.has(nextAppend)) { await new Promise(r => { waiters.push(r); setTimeout(r, 500); }); continue; }
      const bytes = got.get(nextAppend); got.delete(nextAppend);
      await append(bytes);
      streamBytesIn += bytes.length;
      nextAppend++;
      wake();
      if (onProgress) onProgress(nextAppend, meta.total);
      if (!readyCalled && nextAppend >= Math.min(MSE_START_CHUNKS, meta.total)) { readyCalled = true; if (onReady) onReady(meta); }
    }
    await Promise.all(fetchers);
    if (!alive()) return { ok: false, cancelled: true };
    if (ms.readyState === 'open') ms.endOfStream();   // the exact duration is known now
    return { ok: true, url, stream: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e), mseFailed: true };
  }
}

async function loadCurrent(autoplay){
  renderMeta();
  const myIdx = idx;
  const t = tracks[myIdx];
  loading = true;
  spinnerEl.style.display = 'block';
  playBtn.disabled = true;
  artistEl.textContent = 'Preparing audio…';

  // Stage 1 (search mode): the server looks up the mp3 link on y2mate. This can take tens of seconds.
  if (!t.audioUrl && resolveToken) {
    const r = await sendAction({ type:'aiRichAction', token: resolveToken, index: myIdx }, 100000);
    // the user switched tracks while waiting for resolve: this result is not the UI's business anymore.
    // (audioUrl is still stored so coming back to this track later does not resolve again)
    if (r.success && r.audioUrl) t.audioUrl = r.audioUrl;
    if (idx !== myIdx) return;
    if (!(r.success && r.audioUrl)) {
      loading = false; spinnerEl.style.display = 'none'; playBtn.disabled = false;
      titleEl.textContent = 'Failed to load track';
      showError(r.message || 'Resolve failed');
      return;
    }
  }

  // Stage 2: get the audio over WebSocket. Streaming (MSE) if supported, otherwise -> full Blob.
  const finishUi = () => { loading = false; spinnerEl.style.display = 'none'; playBtn.disabled = false; };
  const showArtist = () => { artistEl.textContent = (t.artists||[]).join(', ') || ' '; };

  // already fully downloaded before (e.g. going back to the previous track) -> use it directly
  if (blobCache.has(myIdx)) {
    finishUi(); showArtist();
    audioEl.src = blobCache.get(myIdx); audioEl.load(); loadedIdx = myIdx;
    if (autoplay) attemptPlay();
    return;
  }

  if (mseSupported()) {
    let started = false;
    const r = await streamAudio(myIdx,
      (d, tot) => { if (idx === myIdx && !started) artistEl.textContent = 'Preparing… ' + Math.round(d / tot * 100) + '%'; },
      (meta) => {
        if (idx !== myIdx) return;
        started = true;
        finishUi(); showArtist();
        loadedIdx = myIdx;
        streamingIdx = myIdx; streamMeta = meta;
        if (autoplay) attemptPlay();
      });
    if (r.cancelled || idx !== myIdx) return;
    if (r.ok) { streamingIdx = -1; return; }             // streaming finished completely
    if (started) {                                       // failed midway through a song that was already playing
      showError('Streaming interrupted: ' + (r.message || 'unknown'));
      streamingIdx = -1;
      return;
    }
    // failed before playback started -> fall through to Blob below
  }

  const res = await fetchAudioBlobUrl(myIdx, (d, tot) => {
    if (idx === myIdx) artistEl.textContent = 'Downloading audio… ' + Math.round(d / tot * 100) + '%';
  });
  finishUi();
  if (idx !== myIdx) return;
  showArtist();
  if (!res.ok) {
    titleEl.textContent = 'Failed to load track';
    showError(res.message || 'Audio download failed');
    return;
  }
  audioEl.src = res.url;
  audioEl.load();
  loadedIdx = myIdx;
  if (autoplay) attemptPlay();
}

let loadedIdx = -1;   // index of the track whose src is ALREADY set to real audio
let streamingIdx = -1; // index of the track currently being streamed (duration not final yet)
let streamMeta = null;
let streamBytesIn = 0;   // total bytes already appended to MediaSource (for duration estimation)
playBtn.addEventListener('click', async () => {
  if (loading) { return; }
  if (loadedIdx !== idx) { await loadCurrent(true); return; }
  if (audioEl.paused) attemptPlay(); else audioEl.pause();
});

function setIcon(d){ const pth = playIcon.querySelector('path'); if (pth) pth.setAttribute('d', d); }
audioEl.addEventListener('play', () => setIcon(PAUSE_SVG));
audioEl.addEventListener('playing', () => { spinnerEl.style.display = 'none'; setIcon(PAUSE_SVG); });
audioEl.addEventListener('waiting', () => { spinnerEl.style.display = 'block'; });
audioEl.addEventListener('pause', () => setIcon(PLAY_SVG));
audioEl.addEventListener('error', () => {
  const err = audioEl.error;
  const codes = { 1:'ABORTED', 2:'NETWORK', 3:'DECODE', 4:'SRC_NOT_SUPPORTED' };
  spinnerEl.style.display = 'none';
  showError('Audio error: ' + (codes[err?.code] || err?.code || 'unknown') + (err?.message ? ' — ' + err.message : ''));
});
// While streaming (MSE), audioEl.duration only covers the part that has ALREADY arrived (or Infinity/NaN) and keeps
// growing, so the slider would jump around. Estimate the total duration from the file size & measured bitrate.
function totalDuration(){
  const d = audioEl.duration;
  if (streamingIdx === idx && streamMeta && streamMeta.size) {
    // estimated bitrate from the data buffered so far: bytes_in / seconds_in
    let secIn = 0;
    try { if (audioEl.buffered.length) secIn = audioEl.buffered.end(audioEl.buffered.length - 1); } catch (e) {}
    const bytesIn = Math.min(streamMeta.size, (streamBytesIn || 0));
    if (secIn > 1 && bytesIn > 0) return streamMeta.size / (bytesIn / secIn);
    return isFinite(d) && d > 0 ? d : 0;
  }
  return isFinite(d) && d > 0 ? d : 0;
}
function bufferedEnd(){
  try { return audioEl.buffered.length ? audioEl.buffered.end(audioEl.buffered.length - 1) : 0; } catch (e) { return 0; }
}
audioEl.addEventListener('timeupdate', () => {
  const dur = totalDuration();
  if (!dur) return;
  seekEl.value = Math.min(100, (audioEl.currentTime / dur) * 100);
  curTimeEl.textContent = fmt(audioEl.currentTime);
  durTimeEl.textContent = fmt(dur);
});
audioEl.addEventListener('ended', () => { if (!single) goNext(); });
seekEl.addEventListener('input', () => {
  const dur = totalDuration();
  if (!dur) return;
  let target = (seekEl.value / 100) * dur;
  // while streaming, do not jump to a part that has not arrived yet (it would stall) -> clamp to the buffer end
  if (streamingIdx === idx) target = Math.min(target, Math.max(0, bufferedEnd() - 1));
  audioEl.currentTime = target;
});

function goPrev(){
  if (single) return;
  idx = (idx - 1 + tracks.length) % tracks.length;
  loadedIdx = -1; streamingIdx = -1; streamSession++;
  loading = false; spinnerEl.style.display = 'none'; playBtn.disabled = false;
  audioEl.pause(); audioEl.currentTime = 0; seekEl.value = 0;
  loadCurrent(true);
}
function goNext(){
  if (single) return;
  idx = (idx + 1) % tracks.length;
  loadedIdx = -1; streamingIdx = -1; streamSession++;
  loading = false; spinnerEl.style.display = 'none'; playBtn.disabled = false;
  audioEl.pause(); audioEl.currentTime = 0; seekEl.value = 0;
  loadCurrent(true);
}
prevBtn.addEventListener('click', goPrev);
nextBtn.addEventListener('click', goNext);

dlBtn.addEventListener('click', async () => {
  if (!downloadToken) { dlBtn.textContent = 'Unavailable'; return; }
  dlBtn.disabled = true;
  dlBtn.textContent = 'Sending...';
  const result = await sendAction({ type:'aiRichAction', token: downloadToken, index: idx });
  dlBtn.textContent = result.success ? 'Sent!' : ('Failed: ' + (result.message || 'unknown'));
  setTimeout(() => { dlBtn.disabled = false; dlBtn.textContent = 'Download'; }, 3000);
});

renderMeta();
// Single mode: the mp3 link already exists -> prepare the audio in the background so play starts instantly.
// Search mode: do NOT start anything before the user presses play (y2mate resolve + download are expensive).
if (single) {
  loadCurrent(false);
}
</script>`
}
