import { canvas } from 'hiro/canvas'

const W = 1999
const H = 1158
const SPLIT = 1000
const FADE_FROM = 480
const FALLBACK_PP = 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'
const FONT_FAMILY = 'QuoteFont'
const FONT_SOURCES = [
    'https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
]

let fontReady = null

const prepareFont = () => fontReady ||= (async () => {
    for (const source of FONT_SOURCES) {
        try {
            await canvas.loadFont(source, { family: FONT_FAMILY })
            return FONT_FAMILY
        } catch {}
    }
    return 'sans-serif'
})()

const download = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
}

const loadAvatarFrom = async urls => {
    for (const source of urls) {
        if (!source) continue
        try {
            return await canvas.loadImage(await download(source))
        } catch {}
    }
    return null
}

const identify = async (conn, m, jid, platform) => {
    if (platform === 'discord') {
        const raw = String(jid || '').replace(/@discord$/, '')
        const id = /^\d{15,22}$/.test(raw) ? raw : null
        const user = id ? await global.discord?.client?.users?.fetch(id).catch(() => null) : null
        const name = user?.globalName || user?.username || (jid === m.sender ? m.name : null) || 'User'
        return { name, avatar: await loadAvatarFrom([user?.displayAvatarURL({ size: 1024 }), FALLBACK_PP]) }
    }
    const url = await conn.profilePictureUrl(jid, 'image').catch(() => null)
    const name = db.data.users[jid]?.name || conn.getName(jid) || String(jid).split('@')[0]
    return { name, avatar: await loadAvatarFrom([url, FALLBACK_PP]) }
}

const wrap = (ctx, text, maxWidth) => {
    const lines = []
    for (const paragraph of String(text).split('\n')) {
        const words = paragraph.split(/\s+/).filter(Boolean)
        if (!words.length) {
            lines.push('')
            continue
        }
        let line = ''
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word
            if (ctx.measureText(candidate).width <= maxWidth) {
                line = candidate
                continue
            }
            if (line) lines.push(line)
            line = ''
            let chunk = ''
            for (const ch of word) {
                if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
                    lines.push(chunk)
                    chunk = ch
                } else chunk += ch
            }
            line = chunk
        }
        if (line) lines.push(line)
    }
    return lines
}

const drawPhoto = (ctx, img) => {
    const scale = Math.max(SPLIT / img.width, H / img.height)
    const dw = img.width * scale
    const dh = img.height * scale
    ctx.drawImage(img, (SPLIT - dw) / 2, (H - dh) / 2, dw, dh)

    const data = ctx.getImageData(0, 0, SPLIT, H)
    const px = data.data
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < SPLIT; x++) {
            const i = (y * SPLIT + x) * 4
            const gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
            let k = 1
            if (x > FADE_FROM) {
                const t = (x - FADE_FROM) / (SPLIT - FADE_FROM)
                k = Math.pow(1 - t, 1.6)
            }
            const v = gray * k
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 255
        }
    }
    ctx.putImageData(data, 0, 0)
    ctx.fillStyle = '#000000'
    ctx.fillRect(SPLIT, 0, W - SPLIT, H)
}

const render = async ({ avatar, text, name, family }) => {
    const cv = canvas.createCanvas(W, H)
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, W, H)

    if (avatar) drawPhoto(ctx, avatar)

    const areaLeft = SPLIT + 30
    const areaRight = W - 90
    const maxWidth = areaRight - areaLeft
    const centerX = (areaLeft + areaRight) / 2
    const quote = `"${text}"`

    let size = 58
    let lines
    let lineHeight
    const authorSize = 30
    const reserved = 190
    for (; size >= 22; size -= 2) {
        ctx.font = `${size}px ${family}`
        lines = wrap(ctx, quote, maxWidth)
        lineHeight = size * 1.28
        if (lines.length * lineHeight <= H - reserved - 120) break
    }

    const blockHeight = lines.length * lineHeight + 28 + authorSize
    let y = (H - blockHeight) / 2

    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = `${size}px ${family}`
    for (const line of lines) {
        ctx.fillText(line, centerX, y)
        y += lineHeight
    }

    y += 28
    ctx.font = `${authorSize}px ${family}`
    ctx.fillText(`- ${name}`, centerX, y, maxWidth)

    return cv.toBuffer('image/png')
}

const handler = async (m, { conn, text, usedPrefix, command, platform }) => {
    const quoted = m.quoted
    const content = (quoted ? (quoted.text || quoted.caption || '') : text || '').trim()
    if (!content) return m.reply(`*• Example :* ${usedPrefix + command} <reply/text>`)

    const jid = quoted ? quoted.sender : m.sender
    const [{ name, avatar }, family] = await Promise.all([identify(conn, m, jid, platform), prepareFont()])
    const buffer = await render({ avatar, text: content.slice(0, 600), name, family })

    if (platform === 'discord') return conn.discord(m.chat, { image: buffer, fileName: 'quotes.png' })
    await conn.sendMessage(m.chat, { image: buffer }, { quoted: m })
}

handler.help = [
    'quotes <reply/text>',
    { command: 'quotes', name: 'text', description: 'Quote text, or reply to a message', type: 'string' }
]
handler.tags = ['canvas']
handler.command = ['quotes']
handler.description = 'Make a quote image from a replied message or text'
handler.limit = 1
handler.ai = { risk: 'low', description: 'create a quote image. "/quotes <text>" or reply to a message with "/quotes"' }

handler.platform = { whatsapp: true, discord: true }

export default handler
