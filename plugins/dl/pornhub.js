import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const ffmpegPath = '/usr/bin/ffmpeg'
const phTmpDir = path.join(process.cwd(), 'data/tmp')

const { scrapePornhub, searchPornhub } = global.scraper.pornhub

if (!global.phSessions) global.phSessions = {}
if (!global.phSearchState) global.phSearchState = {}

const sessionTtl = 20 * 60 * 1000

function cleanSessions() {
    const now = Date.now()
    for (const k of Object.keys(global.phSessions)) {
        if (now - global.phSessions[k].ts > sessionTtl) delete global.phSessions[k]
    }
    for (const k of Object.keys(global.phSearchState)) {
        if (now - global.phSearchState[k].ts > sessionTtl) delete global.phSearchState[k]
    }
}

function mkToken(sender) {
    return `${(sender || '').split('@')[0]}_${Date.now().toString(36)}`
}

function ensureTmp() {
    try {
        if (!fs.existsSync(phTmpDir)) fs.mkdirSync(phTmpDir, { recursive: true })
        fs.accessSync(phTmpDir, fs.constants.W_OK)
        return phTmpDir
    } catch {
        return '/tmp'
    }
}

const ffmpegTimeoutMs = 10 * 60 * 1000
const staleTmpMs = 30 * 60 * 1000

async function hlsToMp4(m3u8Url) {
    const tmpDir = ensureTmp()
    try {
        fs.readdirSync(tmpDir)
            .filter(f => f.startsWith('ph_tmp_'))
            .forEach(f => {
                try {
                    const file = path.join(tmpDir, f)
                    if (Date.now() - fs.statSync(file).mtimeMs > staleTmpMs) fs.unlinkSync(file)
                } catch {}
            })
    } catch {}

    const ts = Date.now()
    const out = path.join(tmpDir, `ph_tmp_${ts}.mp4`)

    try {
        await execFileAsync(ffmpegPath, [
            '-y',
            '-nostdin',
            '-nostats',
            '-loglevel', 'error',
            '-allowed_extensions', 'ALL',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-headers', `User-Agent: ${global.scraper.pornhub.phHeaders['User-Agent']}\r\nReferer: https://www.pornhub.com\r\n`,
            '-i', m3u8Url,
            '-c', 'copy',
            '-movflags', 'faststart',
            '-bsf:a', 'aac_adtstoasc',
            '-f', 'mp4',
            out
        ], { timeout: ffmpegTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
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
            text: `**${data.title}**\nUploader: ${data.uploader}\n\nChoose a format:`,
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
        text: `*${data.title}*\nUploader: ${data.uploader}\n──────────────\nChoose a download format:`,
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
            select: { placeholder: 'Choose a video', options },
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
        if (!session) return m.reply('This session has expired, run the command again.')
        const index = Number(phdl[2])
        if (index < 0 || index >= session.allLinks.length) return m.reply('Invalid index.')
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
        if (!state) return m.reply('Search expired, search again.')
        const item = state.results[Number(phget[2])]
        if (!item) return m.reply('Item not found.')
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
        if (!state) return m.reply('Search expired, search again.')
        const page = Number(phpage[2])
        await m.react('🔍')
        try {
            const { results, hasNext } = await searchPornhub(state.query, page)
            if (!results.length) return m.reply('No results on this page.')
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

    if (!input) return m.reply(`Send a link or a search query.\nExample: *${usedPrefix + command} eipril*`)

    await m.react('🔍')
    try {
        const { results, hasNext } = await searchPornhub(input)
        if (!results.length) return m.reply(`No results for: *${input}*`)
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
handler.description = 'Download or search videos from Pornhub'
handler.limit = 1
handler.level = 1
handler.ai = { risk: 'low', description: 'search or download pornhub video using url or keywords' }
handler.platform = { whatsapp: true, discord: true }

export default handler

function isLink(text) {
    if (!text) return null
    return text.match(/https?:\/\/\S+/gi)
}