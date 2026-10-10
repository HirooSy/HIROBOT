import axios from "axios";
import { URL_REGEX } from 'baileys';

let handler = async(m, { conn, usedPrefix, command, text }) => {
    let chat = db.data.chats[m.chat]
    if (!text) return m.reply(`> *SEARCH -* [ ${usedPrefix + command} <Music_name> ]\n> *DOWNLOAD -* [ ${usedPrefix + command} <Spotify_link> ]`)

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
const UA          = "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

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

    const audio = await global.scraper.ytdl.ytdl('audio', `https://www.youtube.com/watch?v=${top.videoId}`);

    return {
        metadata: {
            name: title,
            artist: artist || null,
            album: album || null,
            cover: thumbnail || null
        },
        links: {
            mp3: audio.buffer,
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