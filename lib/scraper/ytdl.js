import yts from 'yt-search'
import fetch from 'node-fetch'

const EPSILON_HOST = 'epsilon.epsiloncloud.org'
const EPSILON_FRONTEND = 'https://convertytmp3.org'

const EPSILON_HEADERS = {
    'Origin': EPSILON_FRONTEND,
    'Referer': `${EPSILON_FRONTEND}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
    'Accept': '*/*',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
}

function extractYoutubeId(url) {
    const re = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/)|[?&]v=)([a-zA-Z0-9-_]{11})/
    const match = url.match(re)
    return match ? match[1] : null
}

async function epsilonCall(url, authKey, retry = 0) {
    const headers = { ...EPSILON_HEADERS }
    if (authKey) headers.Authorization = `Bearer ${authKey}`

    const res = await fetch(url, { headers })

    // Upstream sometimes 403s transiently (rate-limit/anti-bot heuristics on
    // their end) — same retry behavior as the original standalone script.
    if (res.status === 403 && retry < 3) {
        await new Promise(r => setTimeout(r, 2000))
        return epsilonCall(url, authKey, retry + 1)
    }

    const bodyText = await res.text()
    if (!res.ok) {
        throw new Error(`Epsilon API error ${res.status} for ${url}`)
    }
    return JSON.parse(bodyText)
}

export async function ytdl(type = 'audio', url) {
    const format = type === 'audio' ? 'mp3' : 'mp4'
    const videoId = extractYoutubeId(url)

    if (!videoId) {
        throw new Error(`YouTube download error: could not extract a valid video ID from URL: ${url}`)
    }

    try {
        // 1. Auth handshake
        const { key } = await epsilonCall(`https://${EPSILON_HOST}/api/v1/auth?_=${Date.now()}`)

        // 2. Start session
        const session = await epsilonCall(`https://${EPSILON_HOST}/api/v1/init?_=${Date.now()}`, key)

        // 3. Convert (following redirects until we get progressURL/downloadURL)
        let step = await epsilonCall(`${session.convertURL}&v=${videoId}&f=${format}&_=${Date.now()}`, key)
        let redirectHops = 0
        while (step.redirectURL) {
            if (++redirectHops > 10) {
                throw new Error('Too many redirects while starting conversion')
            }
            step = await epsilonCall(`${step.redirectURL}&v=${videoId}&f=${format}&_=${Date.now()}`, key)
        }

        let { progressURL, downloadURL } = step
        let title = step.title

        // 4. Poll progress until ready (progress >= 3). downloadURL can be
        // refreshed mid-polling — always keep the most recent value seen,
        // matching the original script's behavior exactly.
        if (progressURL) {
            let attempts = 0
            const maxAttempts = 40 // ~2 minutes at 3s/poll — generous but bounded
            let lastProgress = -1

            while (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 3000))
                const progress = await epsilonCall(`${progressURL}&_=${Date.now()}`, key)

                if (progress.title) title = progress.title
                if (progress.downloadURL) downloadURL = progress.downloadURL
                lastProgress = progress.progress
                attempts++

                if (lastProgress >= 3) break
            }

            if (lastProgress < 3) {
                throw new Error(`Conversion timed out after ${maxAttempts * 3} seconds (stuck at progress ${lastProgress})`)
            }
        }

        if (!downloadURL) {
            throw new Error('No download URL found in response')
        }

        // 5. Download the actual file bytes. This request needs the SAME
        // Bearer auth as every other call — Baileys can't attach that
        // header if just given a bare {url}, so we fetch the bytes here
        // and hand back a Buffer instead.
        const fileRes = await fetch(`${downloadURL}&v=${videoId}&f=${format}&r=bot`, {
            headers: { ...EPSILON_HEADERS, Authorization: `Bearer ${key}` },
            redirect: 'follow'
        })
        if (!fileRes.ok) {
            throw new Error(`File download failed with status ${fileRes.status}`)
        }
        const buffer = Buffer.from(await fileRes.arrayBuffer())

        let views, duration, thumbnail, channel
        try {
            const meta = await yts({ videoId })
            views = meta?.views
            duration = meta?.duration?.timestamp || meta?.timestamp
            thumbnail = meta?.thumbnail
            channel = meta?.author?.name
        } catch (metaErr) {
            console.warn('[ytdl] yts metadata fallback failed:', metaErr.message)
        }

        return {
            buffer,
            mime: format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
            title: title || videoId,
            views: views ?? 0,
            duration: duration || 'Unknown',
            thumbnail: thumbnail || null,
            channel: channel || 'Unknown'
        }
    } catch (error) {
        throw new Error(`YouTube download error: ${error.message}`)
    }
}

export default ytdl
