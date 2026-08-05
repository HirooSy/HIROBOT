import axios from "axios";
const cheerio = (await import("cheerio"));
import { URL_REGEX } from 'baileys';

let handler = async(m, { conn, usedPrefix, command, text }) => {
    let chat = db.data.chats[m.chat]
    if (!text) return m.reply(`> *SEARCH -* [ ${usedPrefix + command} <Music_name> ]\n> *DOWNLOAD -* [ ${usedPrefix + command} <Spotify_link> ]`)

    if (!text.match(URL_REGEX)) {
        const res = await searchSpotify(text)
        if (!res?.success || !res?.results?.length) return m.reply("- *Error:* " + res.message)

        const rows = res.results.map((v, i) => ({
            header     : `${v.title}`,
            title      : `Artist: ${v.artists.join(', ')}  •  Duration: ${v.duration}`,
            description: `📁 ${v.album?.name || 'Unknown Album'}`,
            id         : `${usedPrefix}spotify ${v.spotifyUrl}`
        }))

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
            return m.reply("- Failed to get song data.\n- Debug: track tidak ditemukan di spotidown.app")
        }

        const { metadata, links } = result

        const trackName = metadata.name || 'Unknown Title'
        const coverUrl  = links.cover || metadata.cover || null
        const audioUrl  = links.mp3

        if (!audioUrl) {
            return m.reply("- Failed to get song data.\n- Debug: link mp3 kosong, cek console log.")
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
}

handler.tags    = ["downloader"]
handler.help    = ["spotify <name/link>"]
handler.command = ["spotify"]
handler.ai      = { risk:"low", description:"search/download spotify music" }

export default handler

const BASE_URL   = 'https://spotidown.app';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const searchCache = new Map();
const pendingSearches = new Map();
const SEARCH_CACHE_TTL = 30_000;

async function getSpotidownSession() {
    const response = await axios.get(`${BASE_URL}/en3`, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    });

    const cookies = response.headers['set-cookie'] || [];
    if (!cookies.length) {
        throw new Error('spotidown.app tidak mengirim set-cookie header (mungkin situs down / berubah / diblokir)');
    }
    const sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');

    const $ = cheerio.load(response.data);
    const form = $('form[name="spotifyurl"]');
    if (!form.length) {
        throw new Error('Form pencarian Spotify tidak ditemukan di homepage spotidown.app (HTML mungkin berubah struktur)');
    }

    let dynamicName = '';
    let dynamicValue = '';
    form.find('input[type="hidden"]').each((i, elem) => {
        const name = $(elem).attr('name');
        const val = $(elem).attr('value');
        if (name && name !== 'g-recaptcha-response') {
            dynamicName = name;
            dynamicValue = val;
        }
    });

    return { sessionCookie, dynamicName, dynamicValue };
}

async function spotidownResolve(queryOrUrl) {
    const { sessionCookie, dynamicName, dynamicValue } = await getSpotidownSession();

    const payload = {
        url: queryOrUrl,
        'g-recaptcha-response': '',
    };
    if (dynamicName) {
        payload[dynamicName] = dynamicValue;
    }

    const response = await axios.post(`${BASE_URL}/action`, new URLSearchParams(payload).toString(), {
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': BASE_URL,
            'Referer': `${BASE_URL}/en3`,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': sessionCookie
        }
    });

    if (response.data.error) {
        throw new Error(response.data.message || 'Lookup gagal di spotidown.app');
    }

    const $ = cheerio.load(response.data.data);
    const tracks = [];

    $('form[name="submitspurl"]').each((i, formElem) => {
        const form = $(formElem);
        const data  = form.find('input[name="data"]').val();
        const base  = form.find('input[name="base"]').val();
        const token = form.find('input[name="token"]').val();

        if (data && base && token) {
            let metadata = {};
            try {
                const decodedMeta = Buffer.from(data, 'base64').toString('utf8');
                metadata = JSON.parse(decodedMeta);
            } catch (e) {
                metadata = { error: 'Failed parsing metadata' };
            }

            tracks.push({
                metadata,
                form: { data, base, token }
            });
        }
    });

    return { tracks, sessionCookie };
}

async function spotidownGetLinks(form, sessionCookie) {
    const response = await axios.post(`${BASE_URL}/action/track`, new URLSearchParams(form).toString(), {
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': BASE_URL,
            'Referer': `${BASE_URL}/en3`,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': sessionCookie
        }
    });

    if (response.data.error) {
        throw new Error(response.data.message || 'Gagal mengambil link download dari spotidown.app');
    }

    const $ = cheerio.load(response.data.data);
    const links = { mp3: null, cover: null };

    $('a').each((i, elem) => {
        const href = $(elem).attr('href');
        const txt  = $(elem).text().trim().replace(/\s+/g, ' ').toLowerCase();
        if (!href) return;

        if (txt.includes('download mp3')) {
            links.mp3 = href;
        } else if (txt.includes('download cover')) {
            links.cover = href;
        }
    });

    return links;
}

async function searchSpotify(query) {
    const normalizedQuery = String(query || "").trim();

    if (!normalizedQuery) {
        return { success: false, message: "Query pencarian tidak boleh kosong" };
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
            const { tracks } = await spotidownResolve(normalizedQuery);

            const results = tracks.map(t => {
                const meta = t.metadata || {};
                const spotifyUrl = meta.tid
                    ? `https://open.spotify.com/track/${meta.tid}`
                    : null;

                return {
                    id: meta.tid || null,
                    title: meta.name || 'Unknown Title',
                    artists: meta.artist ? [meta.artist] : [],
                    durationMs: null,
                    duration: meta.duration || '0:00',
                    spotifyUrl,
                    album: {
                        name: meta.album || null,
                        cover: meta.cover || null
                    }
                };
            }).filter(v => v.spotifyUrl);

            const result = {
                success: results.length > 0,
                total: results.length,
                results,
                message: results.length ? undefined : 'Tidak ada hasil ditemukan'
            };

            searchCache.set(cacheKey, {
                result,
                expiresAt: Date.now() + SEARCH_CACHE_TTL
            });

            return result;
        } catch (error) {
            return {
                success: false,
                message: error.message || "Gagal mencari lagu"
            };
        } finally {
            pendingSearches.delete(cacheKey);
        }
    })();

    pendingSearches.set(cacheKey, searchPromise);
    return searchPromise;
}

async function spotifyDownloadByUrl(spotifyUrl) {
    const { tracks, sessionCookie } = await spotidownResolve(spotifyUrl);

    if (!tracks.length) {
        return null;
    }

    const track = tracks[0];
    const links = await spotidownGetLinks(track.form, sessionCookie);

    return {
        metadata: track.metadata,
        links
    };
}
