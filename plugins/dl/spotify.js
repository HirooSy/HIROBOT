import axios from "axios";
const cheerio = (await import("cheerio"));
import fetch from "node-fetch";
import { URL_REGEX } from 'baileys';

// ── Handler ───────────────────────────────────────────────────────────────────
let handler = async(m, { conn, usedPrefix, command, text }) => {
    let chat = db.data.chats[m.chat]
    if (!text) return m.reply(`> *SEARCH -* [ ${usedPrefix + command} <Music_name> ]\n> *DOWNLOAD -* [ ${usedPrefix + command} <Spotify_link> ]`)

    if (!text.match(URL_REGEX)) {
        // ── SEARCH → nativeFlow ───────────────────────────────────────────────
        const res = await searchSpotify(text)
        if (!res?.success || !res?.results?.length) return m.reply("- *Error:* " + res.message)

        const rows = res.results.map((v, i) => ({
            header     : `${v.title}`,
            title      : `Artist: ${v.artists.join(', ')}  •  Duration: ${v.duration}`,
            description: `📁 ${v.album?.name || 'Unknown Album'}`,
            id         : `${usedPrefix}spotify ${v.spotifyUrl}`
        }))

        const thumb = await conn.resize(
            await (await fetch(res.results[0].album?.cover || 'https://i.scdn.co/image/ab67616d0000b273')).buffer(), 100, 100
        ).catch(() => null)

        return conn.sendMessage(m.chat, {
            document   : { url: res.results[0].album?.cover || 'https://i.scdn.co/image/ab67616d0000b273' },
            jpegThumbnail: thumb,
            mimetype   : 'image/webp',
            caption    : " ",
            fileName   : 'SPOTIFY SEARCH',
            fileLength : '665666646645000',
            optionText : 'Select',
            optionTitle: 'Select',
            nativeFlow : [
                { text: 'Select', sections: [{ title: 'Result', rows }] }
            ],
        }, { quoted: m })

    } else {
        // ── DOWNLOAD ──────────────────────────────────────────────────────────
        if (!/open\.spotify\.com/i.test(text)) {
            return m.reply("- Only support Spotify link.")
        }

        // Ambil info + download dari spotmate
        // NOTE: sebelumnya kalau salah satu gagal, error-nya ditelan begitu saja
        // (.catch(() => [null, null])), jadi kita tidak pernah tahu penyebabnya.
        // Sekarang kita jalankan terpisah + log detail errornya.
        const [infoResult, downloadResult] = await Promise.allSettled([
            spotifyGetInfo(text),
            spotifyDownload(text)
        ])

        if (infoResult.status === "rejected") {
            console.error("spotifyGetInfo error:", infoResult.reason?.response?.status, infoResult.reason?.response?.data || infoResult.reason?.message)
        }
        if (downloadResult.status === "rejected") {
            console.error("spotifyDownload error:", downloadResult.reason?.response?.status, downloadResult.reason?.response?.data || downloadResult.reason?.message)
        }

        const info = infoResult.status === "fulfilled" ? infoResult.value : null
        const download = downloadResult.status === "fulfilled" ? downloadResult.value : null

        if (!info || !download) {
            // Kasih tau error paling relevan ke user (opsional, bisa dihapus kalau mau tetap generik)
            const errMsg = infoResult.reason?.message || downloadResult.reason?.message || "Unknown error"
            return m.reply(`- Failed to get song data.\n- Debug: ${errMsg}`)
        }

        const trackName  = info.name
        const artistName = Object.values(info.artists || {}).map(v => v.name).join(', ') || 'Unknown Artist'
        const albumName  = info.album?.name ?? ''
        const coverUrl   = info.album?.images?.[0]?.url ?? null
        const audioUrl   = download.url

        if (!audioUrl) {
            console.error("spotifyDownload returned no url. Full payload:", JSON.stringify(download))
            return m.reply("- Failed to get song data.\n- Debug: download.url kosong, cek console log.")
        }

        // Thumbnail
        let thumbBuffer = null
        if (coverUrl) {
            try {
                thumbBuffer = await conn.resize(
                    await (await fetch(coverUrl)).buffer(), 150, 150
                )
            } catch {}
        }

        // Kirim audio
        await conn.sendMessage(m.chat, {
            audio     : { url: audioUrl },
            mimetype  : 'audio/mpeg',
            asDocument: chat.useDocument,
            fileName  : `${trackName}.mp3`,
        }, { quoted: { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: thumbBuffer, itemCount: 666, status: 1, surface: 1,message: trackName , orderTitle: trackName, sellerJid: '0@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR"}}} })
    }
}

handler.tags    = ["downloader"]
handler.help    = ["spotify <name/link>"]
handler.command = handler.dym = ["spotify"]
handler.ai      = { risk:"low", description:"search/download spotify music" }

export default handler

// ── SPOTIFY SEARCH (Token anonim dari embed) ──────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null;

const searchCache = new Map();
const pendingSearches = new Map();

const SEARCH_CACHE_TTL = 30_000;
const MAX_RETRIES = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getRetryDelay(error, attempt) {
    const retryAfter = Number(
        error.response?.headers?.["retry-after"]
    );

    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return retryAfter * 1000;
    }

    return Math.min(1000 * (2 ** attempt), 30_000)
        + Math.floor(Math.random() * 500);
}

async function axiosWithRetry(config, maxRetries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await axios(config);
        } catch (error) {
            const status = error.response?.status;

            if (status !== 429 || attempt === maxRetries) {
                throw error;
            }

            const delay = getRetryDelay(error, attempt);

            console.warn(
                `Spotify 429, retry dalam ${Math.ceil(delay / 1000)} detik`
            );

            await sleep(delay);
        }
    }

    throw new Error("Request Spotify gagal");
}

async function getSpotifyToken(forceRefresh = false) {
    const tokenStillValid =
        cachedToken &&
        Date.now() < tokenExpiry - 60_000;

    if (!forceRefresh && tokenStillValid) {
        return cachedToken;
    }

    if (tokenPromise) {
        return tokenPromise;
    }

    tokenPromise = (async () => {
        const { data: html } = await axiosWithRetry({
            method: "GET",
            url: "https://open.spotify.com/embed/track/3HHqVJHqwgkxWhOQ4MhLB6",
            headers: {
                "User-Agent": UA,
                "Accept-Language": "en-US,en;q=0.9",
                Accept: "text/html"
            },
            timeout: 15_000
        });

        const tokenMatch = html.match(
            /"accessToken"\s*:\s*"([^"]+)"/
        );

        const expiryMatch = html.match(
            /"accessTokenExpirationTimestampMs"\s*:\s*(\d+)/
        );

        const token = tokenMatch?.[1];

        const expiry = Number(expiryMatch?.[1])
            || Date.now() + 3_600_000;

        if (!token) {
            throw new Error("Gagal ambil access token anonim");
        }

        cachedToken = token;
        tokenExpiry = expiry;

        return token;
    })().finally(() => {
        tokenPromise = null;
    });

    return tokenPromise;
}

async function requestSpotifySearch(query, retryAuth = true) {
    const token = await getSpotifyToken();

    try {
        return await axiosWithRetry({
            method: "GET",
            url: "https://api.spotify.com/v1/search",
            headers: {
                "User-Agent": UA,
                Authorization: `Bearer ${token}`,
                Accept: "application/json"
            },
            params: {
                q: query,
                type: "track",
                limit: 20,
                market: "ID"
            },
            timeout: 15_000
        });
    } catch (error) {
        if (error.response?.status === 401 && retryAuth) {
            cachedToken = null;
            tokenExpiry = 0;

            await getSpotifyToken(true);

            return requestSpotifySearch(query, false);
        }

        throw error;
    }
}

async function searchSpotify(query) {
    const normalizedQuery = String(query || "").trim();

    if (!normalizedQuery) {
        return {
            success: false,
            message: "Query pencarian tidak boleh kosong"
        };
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
            const { data } = await requestSpotifySearch(
                normalizedQuery
            );

            const tracks = data.tracks?.items || [];

            const result = {
                success: true,
                total: data.tracks?.total || 0,
                results: tracks.map(track => ({
                    id: track.id,
                    title: track.name,
                    artists:
                        track.artists?.map(artist => artist.name)
                        || [],
                    artistIds:
                        track.artists?.map(artist => artist.id)
                        || [],
                    durationMs: track.duration_ms,
                    duration: msToClock(track.duration_ms),
                    isExplicit: track.explicit,
                    popularity: track.popularity ?? null,
                    previewUrl: track.preview_url || null,
                    spotifyUrl:
                        track.external_urls?.spotify
                        || `https://open.spotify.com/track/${track.id}`,
                    album: {
                        name: track.album?.name || null,
                        id: track.album?.id || null,
                        releaseDate:
                            track.album?.release_date || null,
                        cover:
                            track.album?.images?.[0]?.url || null
                    }
                }))
            };

            searchCache.set(cacheKey, {
                result,
                expiresAt: Date.now() + SEARCH_CACHE_TTL
            });

            return result;
        } catch (error) {
            const retryAfter = Number(
                error.response?.headers?.["retry-after"]
            );

            console.error("Spotify search error:", {
                status: error.response?.status,
                retryAfter,
                data: error.response?.data
            });

            return {
                success: false,
                status: error.response?.status || 500,
                retryAfter:
                    Number.isFinite(retryAfter)
                        ? retryAfter
                        : null,
                message:
                    error.response?.data?.error?.message
                    || error.message
                    || "Gagal mencari lagu"
            };
        } finally {
            pendingSearches.delete(cacheKey);
        }
    })();

    pendingSearches.set(cacheKey, searchPromise);

    return searchPromise;
}

function msToClock(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Helper: ambil cookie string dengan aman ────────────────────────────────
function buildCookieHeader(setCookieArr) {
    if (!Array.isArray(setCookieArr) || setCookieArr.length === 0) {
        throw new Error("spotmate.online tidak mengirim set-cookie header (mungkin situs down / berubah / diblokir)")
    }
    // ambil semua cookie yang ada, bukan cuma asumsi index 0 dan 1
    return setCookieArr.map(c => c.split(";")[0]).join("; ")
}

// ── DOWNLOAD: Spotmate (Spotify link) ──────────────────────────────────────
async function spotifyDownload(urls) {
    const resp = await axios({ method: "GET", url: "https://spotmate.online" })
    const _$ = cheerio.load(resp.data)
    const cookieHeader = buildCookieHeader(resp.headers["set-cookie"])
    const csrfToken = _$("meta[name='csrf-token']").attr("content")

    if (!csrfToken) {
        console.error("spotifyDownload: CSRF token tidak ditemukan di halaman spotmate.online, HTML mungkin berubah struktur")
    }

    const res = await axios({
        method: "POST",
        url   : "https://spotmate.online/convert",
        data  : { urls },
        headers: {
            "Cookie"      : cookieHeader,
            "Content-Type": "application/json",
            "Referer"     : "https://spotmate.online/",
            "Origin"      : "https://spotmate.online",
            "X-Csrf-Token": csrfToken
        }
    })
    return res.data
}

async function spotifyGetInfo(urls) {
    const resp = await axios({ method: "GET", url: "https://spotmate.online" })
    const _$ = cheerio.load(resp.data)
    const cookieHeader = buildCookieHeader(resp.headers["set-cookie"])
    const csrfToken = _$("meta[name='csrf-token']").attr("content")

    if (!csrfToken) {
        console.error("spotifyGetInfo: CSRF token tidak ditemukan di halaman spotmate.online, HTML mungkin berubah struktur")
    }

    const res = await axios({
        method: "POST",
        url   : "https://spotmate.online/getTrackData",
        data  : { spotify_url: urls },
        headers: {
            "Cookie"      : cookieHeader,
            "Content-Type": "application/json",
            "Referer"     : "https://spotmate.online/",
            "Origin"      : "https://spotmate.online",
            "X-Csrf-Token": csrfToken
        }
    })
    return res.data
}