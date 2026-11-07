import axios from "hiro/axios";

const base        = "https://spotsaver.net"
const ytmApi     = "https://music.youtube.com/youtubei/v1/search"
const ytmKey     = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30"
const ytmVersion = "1.20260915.14.00"
const ua          = "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

const client = axios.create({
  timeout: 90000,
  headers: {
    "User-Agent": ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    "Referer": base + "/id/",
    "Origin": base
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
  const r = await client.get(base + "/api/spotify", { params: { q } })
  const d = parseJson(r.data)
  if (r.status >= 400 || !d?.items) throw new Error("Search failed: HTTP " + r.status)
  return { query: q, type: d.type || "search", count: d.items.length, items: d.items.map(pickTrack) }
}

async function spotsaverInfo(url) {
  if (!url) throw new Error("Empty URL")
  const r = await client.get(base + "/api/spotify", { params: { url } })
  const d = parseJson(r.data)
  if (r.status >= 400 || !d?.items) throw new Error("Info request failed: HTTP " + r.status)
  return { type: d.type, url, count: d.items.length, items: d.items.map(pickTrack) }
}

async function ytmSearch(query) {
  const body = {
    context: { client: { clientName: "WEB_REMIX", clientVersion: ytmVersion, hl: "id", gl: "ID" } },
    query,
    params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"
  }
  const r = await axios.post(ytmApi + "?key=" + ytmKey + "&prettyPrint=false", body, {
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/json",
      "X-Goog-Api-Key": ytmKey,
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": ytmVersion,
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
const searchCacheTtl = 30_000;
const searchCacheMax = 200;

function pruneSearchCache() {
    const now = Date.now();
    for (const [key, entry] of searchCache) {
        if (now >= entry.expiresAt) searchCache.delete(key);
    }
    while (searchCache.size > searchCacheMax) searchCache.delete(searchCache.keys().next().value);
}

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

            pruneSearchCache();
            searchCache.set(cacheKey, {
                result,
                expiresAt: Date.now() + searchCacheTtl
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

export { searchSpotify, spotifyDownloadByTrack, spotifyDownloadByUrl, downloadCover }
async function downloadCover(url) {
    return axios.get(url, { responseType: 'arraybuffer' })
}
