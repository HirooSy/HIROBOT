import axios from 'hiro/axios'
import * as cheerio from 'hiro/cheerio'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const FFMPEG_PATH = '/usr/bin/ffmpeg'
const TMP_DIR = path.join(process.cwd(), 'data/tmp')

const PH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.pornhub.com',
    'Cookie': 'accessAgeDisclaimerPH=2; accessPH=1; cookieConsent=1; platform=pc'
}

if (!global.phSessions) global.phSessions = {}
if (!global.phSearchState) global.phSearchState = {}

const SESSION_TTL = 20 * 60 * 1000

function cleanSessions() {
    const now = Date.now()
    for (const k of Object.keys(global.phSessions)) {
        if (now - global.phSessions[k].ts > SESSION_TTL) delete global.phSessions[k]
    }
    for (const k of Object.keys(global.phSearchState)) {
        if (now - global.phSearchState[k].ts > SESSION_TTL) delete global.phSearchState[k]
    }
}

function mkToken(sender) {
    return `${(sender || '').split('@')[0]}_${Date.now().toString(36)}`
}

function ensureTmp() {
    try {
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
        fs.accessSync(TMP_DIR, fs.constants.W_OK)
        return TMP_DIR
    } catch {
        return '/tmp'
    }
}

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000
const STALE_TMP_MS = 30 * 60 * 1000

async function hlsToMp4(m3u8Url) {
    const tmpDir = ensureTmp()
    try {
        fs.readdirSync(tmpDir)
            .filter(f => f.startsWith('ph_tmp_'))
            .forEach(f => {
                try {
                    const file = path.join(tmpDir, f)
                    if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.unlinkSync(file)
                } catch {}
            })
    } catch {}

    const ts = Date.now()
    const out = path.join(tmpDir, `ph_tmp_${ts}.mp4`)

    try {
        await execFileAsync(FFMPEG_PATH, [
            '-y',
            '-nostdin',
            '-nostats',
            '-loglevel', 'error',
            '-allowed_extensions', 'ALL',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-headers', `User-Agent: ${PH_HEADERS['User-Agent']}\r\nReferer: https://www.pornhub.com\r\n`,
            '-i', m3u8Url,
            '-c', 'copy',
            '-movflags', 'faststart',
            '-bsf:a', 'aac_adtstoasc',
            '-f', 'mp4',
            out
        ], { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
    } catch (e) {
        try { fs.unlinkSync(out) } catch {}
        throw e
    }

    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
        try { fs.unlinkSync(out) } catch {}
        throw new Error('Remux failed — output empty.')
    }
    return out
}

function extractViewkey(url) {
    return (url.match(/[?&]viewkey=([a-zA-Z0-9]+)/) || url.match(/\/video\/([a-zA-Z0-9]+)/))?.[1] ?? null
}

async function scrapePornhub(url) {
    const viewkey = extractViewkey(url)
    if (!viewkey) throw new Error('Could not extract viewkey from URL.')

    const res = await axios.get(`https://www.pornhub.com/view_video.php?viewkey=${viewkey}`, {
        headers: PH_HEADERS, timeout: 20000
    })
    const $ = cheerio.load(res.data)

    const title = $('title').text().replace(/\s*[-–]\s*Pornhub\.com\s*$/i, '').trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || 'Unknown Title'
    const thumbnail = $('meta[property="og:image"]').attr('content') || null
    const uploader = $('.usernameBadgesWrapper a').first().text().trim()
        || $('a.bolded').first().text().trim()
        || 'Unknown'

    let flashvars = null
    $('script').each(function () {
        if (flashvars) return
        const raw = $(this).html() || ''
        if (!raw.includes('mediaDefinitions')) return
        const m = raw.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/)
        if (!m) return
        try { flashvars = JSON.parse(m[1]) } catch {
            try {
                const start = raw.indexOf('{', raw.indexOf('flashvars_'))
                const end = raw.lastIndexOf('}', raw.indexOf(';\n', start)) + 1
                flashvars = JSON.parse(raw.slice(start, end))
            } catch {}
        }
    })

    if (!flashvars) throw new Error('Could not locate flashvars. Video may be age-gated or premium-only.')

    const videoUrls = []
    for (const def of (flashvars.mediaDefinitions || [])) {
        if (!def.videoUrl) continue
        const q = String(def.quality ?? '').trim()
        if (def.format === 'mp4' && /\d/.test(q)) videoUrls.push({ type: 'MP4', quality: `${q}p`, link: [def.videoUrl] })
        else if (def.format === 'hls') videoUrls.push({ type: 'HLS', quality: q ? `${q}p` : 'Auto', link: [def.videoUrl] })
    }

    videoUrls.sort((a, b) => {
        if (a.type === 'JPG') return 1
        if (b.type === 'JPG') return -1
        if (a.type === 'HLS' && b.type !== 'HLS') return 1
        if (b.type === 'HLS' && a.type !== 'HLS') return -1
        return (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0)
    })

    if (!videoUrls.length) throw new Error('No downloadable media found — video may be premium-only.')
    if (thumbnail) videoUrls.push({ type: 'JPG', quality: 'Thumbnail', link: [thumbnail] })

    return { title, uploader, thumbnail, videoUrls }
}

async function searchPornhub(query, page = 1) {
    const res = await axios.get('https://www.pornhub.com/video/search', {
        params: { search: query, page },
        headers: PH_HEADERS,
        timeout: 20000
    })
    const $ = cheerio.load(res.data)
    const results = []

    $('li.pcVideoListItem').each(function () {
        const $item = $(this)
        const $link = $item.find('a.linkVideoThumb').first()
        const href = $link.attr('href')
        if (!href) return
        const videoUrl = href.startsWith('http') ? href : `https://www.pornhub.com${href}`
        const viewkey = extractViewkey(videoUrl)
        if (!viewkey) return

        results.push({
            viewkey,
            url: `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`,
            title: ($item.find('span.title').text() || $item.find('.videoTitle').text() || $link.attr('title') || 'Unknown').trim(),
            duration: ($item.find('var.duration').text() || $item.find('.videoDuration').text()).trim(),
            views: $item.find('.views var').text().trim()
        })
    })

    const hasNext = results.length >= 32 || $('a.page_next').length > 0 || $('[aria-label="next"]').length > 0
    return { results, hasNext }
}

const sendFileOut = (conn, m, url, name, caption) => m.platform === 'discord'
    ? conn.discord(m.chat, { [/\.(jpe?g|png|webp)$/i.test(name) ? 'image' : 'video']: url, fileName: name, text: caption.replace(/\*([^*\n]+)\*/g, '**$1**') })
    : conn.sendFile(m.chat, url, name, caption, m)

async function deliverFormat(conn, m, session, index) {
    const links = session.allLinks[index]
    const type = session.types[index]
    const cap = `*${session.title}*`

    for (const url of links) {
        if (type === 'JPG') {
            await sendFileOut(conn, m, url, 'thumbnail.jpg', cap)
        } else if (type === 'HLS') {
            let tmp = null
            try {
                tmp = await hlsToMp4(url)
                await sendFileOut(conn, m, tmp, 'video.mp4', cap)
            } catch (e) {
                await m.reply(`Send failed: ${e.message}`)
                m.error = e
            } finally {
                if (tmp) try { fs.unlinkSync(tmp) } catch {}
            }
        } else {
            await sendFileOut(conn, m, url, 'video.mp4', cap)
        }
    }
}

async function showFormatMenu(conn, m, data, command) {
    cleanSessions()
    const token = mkToken(m.sender)
    global.phSessions[token] = {
        title: data.title,
        allLinks: data.videoUrls.map(v => v.link),
        types: data.videoUrls.map(v => v.type),
        ts: Date.now()
    }

    if (m.platform === 'discord') {
        return conn.discord(m.chat, {
            text: `**${data.title}**\nUploader: ${data.uploader}\n\nPilih format:`,
            select: {
                placeholder: 'Select format',
                options: data.videoUrls.slice(0, 25).map((v, i) => ({
                    label: `${v.type} — ${v.quality}`.slice(0, 100),
                    action: `${command} phdl ${token} ${i}`
                }))
            }
        })
    }

    const rows = data.videoUrls.map((v, i) => ({
        header: `${v.type} — ${v.quality}`,
        title: '',
        description: '',
        id: `.${command} phdl ${token} ${i}`
    }))

    return conn.sendButton(m.chat, {
        text: `*${data.title}*\nUploader: ${data.uploader}\n──────────────\nPilih format download:`,
        footer: 'Pornhub',
        nativeFlow: [{ text: '\u0000', sections: [{ rows }] }]
    }, m)
}

async function showSearchResult(conn, m, query, results, page, hasNext, command) {
    cleanSessions()
    const token = mkToken(m.sender)
    global.phSearchState[token] = { query, results, page, ts: Date.now() }

    if (m.platform === 'discord') {
        const options = results.slice(0, 25).map((v, i) => ({
            label: `${v.title.slice(0, 85)}${v.duration ? ` [${v.duration}]` : ''}`,
            action: `${command} phget ${token} ${i}`
        }))
        const buttons = []
        if (page > 1) buttons.push({ text: '◀ Prev', id: `${command} phpage ${token} ${page - 1}` })
        if (hasNext) buttons.push({ text: 'Next ▶', id: `${command} phpage ${token} ${page + 1}` })
        return conn.discord(m.chat, {
            text: `**Pornhub — "${query}"** (Page ${page})\n${results.length} results found`,
            select: { placeholder: 'Pilih video', options },
            button: buttons
        })
    }

    const rows = results.slice(0, 10).map((v, i) => ({
        header: v.title.slice(0, 60),
        title: [v.duration, v.views].filter(Boolean).join(' · '),
        description: '',
        id: `.${command} phget ${token} ${i}`
    }))

    const navFlow = []
    if (page > 1) navFlow.push({ text: '◀ Prev', id: `.${command} phpage ${token} ${page - 1}` })
    if (hasNext) navFlow.push({ text: 'Next ▶', id: `.${command} phpage ${token} ${page + 1}` })

    return conn.sendButton(m.chat, {
        text: `*Pornhub — "${query}"*\n_Page ${page} · ${results.length} results_`,
        footer: 'Pornhub Search',
        nativeFlow: [{ text: '\u0000', sections: [{ rows }] }, ...navFlow]
    }, m)
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const input = String(text || '').trim()

    const phdl = input.match(/^phdl\s+(\S+)\s+(\d+)$/)
    if (phdl) {
        const session = global.phSessions[phdl[1]]
        if (!session) return m.reply('Session ini sudah expired, ulangi command.')
        const index = Number(phdl[2])
        if (index < 0 || index >= session.allLinks.length) return m.reply('Index tidak valid.')
        await m.react('⬇️')
        try {
            await deliverFormat(conn, m, session, index)
            await m.react('✅')
        } catch (e) {
            await m.react('❌')
            await m.reply(`Error: ${e.message}`)
            m.error = e
        }
        return
    }

    const phget = input.match(/^phget\s+(\S+)\s+(\d+)$/)
    if (phget) {
        const state = global.phSearchState[phget[1]]
        if (!state) return m.reply('Search expired, cari ulang.')
        const item = state.results[Number(phget[2])]
        if (!item) return m.reply('Item tidak ditemukan.')
        await m.react('⏳')
        try {
            const data = await scrapePornhub(item.url)
            await showFormatMenu(conn, m, data, command)
        } catch (e) {
            await m.reply(`Failed: ${e.message}`)
            m.error = e
        }
        return
    }

    const phpage = input.match(/^phpage\s+(\S+)\s+(\d+)$/)
    if (phpage) {
        const state = global.phSearchState[phpage[1]]
        if (!state) return m.reply('Search expired, cari ulang.')
        const page = Number(phpage[2])
        await m.react('🔍')
        try {
            const { results, hasNext } = await searchPornhub(state.query, page)
            if (!results.length) return m.reply('Tidak ada hasil di halaman ini.')
            await showSearchResult(conn, m, state.query, results, page, hasNext, command)
        } catch (e) {
            await m.reply(`Error: ${e.message}`)
            m.error = e
        }
        return
    }

    if (isLink(input)) {
        await m.react('⏳')
        try {
            const data = await scrapePornhub(isLink(input)[0])
            await showFormatMenu(conn, m, data, command)
        } catch (e) {
            await m.reply(`Failed: ${e.message}`)
            m.error = e
        }
        return
    }

    if (!input) return m.reply(`Kirim link atau query pencarian.\nContoh: *${usedPrefix + command} eipril*`)

    await m.react('🔍')
    try {
        const { results, hasNext } = await searchPornhub(input)
        if (!results.length) return m.reply(`Tidak ada hasil untuk: *${input}*`)
        await showSearchResult(conn, m, input, results, 1, hasNext, command)
    } catch (e) {
        await m.reply(`Search failed: ${e.message}`)
        m.error = e
    }
}

handler.help = [
    ...['ph', 'pornhub'].map(v => v + ' <url|query>'),
    { command: 'ph', name: 'text', description: 'Pornhub URL or search query', type: 'string', required: false }
]
handler.tags = ['adult']
handler.command = ['ph', 'pornhub']
handler.description = 'Download atau cari video dari Pornhub'
handler.limit = 1
handler.level = 1
handler.ai = { risk: 'low', description: 'search or download pornhub video using url or keywords' }
handler.platform = { whatsapp: true, discord: true }

export default handler

function isLink(text) {
    if (!text) return null
    return text.match(/https?:\/\/\S+/gi)
}