import crypto from 'crypto'

const chunkSize = 24
const pendingTtl = 10 * 60 * 1000
const pending = (globalThis.__ttsPending ||= new Map())

const pruneExpired = () => {
    const now = Date.now()
    for (const [token, entry] of pending) {
        if (now - entry.createdAt > pendingTtl) pending.delete(token)
    }
}

const previewText = text => (text.length > 120 ? `${text.slice(0, 117)}...` : text)

const splitName = nama => {
    const [name, ...style] = nama.split(' - ')
    return { name, style: style.join(' - ') }
}

const buildRows = (slice, start, token, prefix) => slice.map((voice, offset) => {
    const { name, style } = splitName(voice.nama)
    return {
        title: name.slice(0, 24),
        description: `${voice.gender} | ${style}`.slice(0, 72),
        id: `${prefix}ttsvoice ${token} ${start + offset + 1}`
    }
})

const sendVoiceList = async (m, conn, voices, token, prefix) => {
    const entry = pending.get(token)
    const sections = []
    for (let start = 0; start < voices.length; start += chunkSize) {
        const slice = voices.slice(start, start + chunkSize)
        const end = start + slice.length
        sections.push({ title: `Voices ${start + 1}-${end}`, rows: buildRows(slice, start, token, prefix) })
    }
    await conn.sendButton(m.chat, {
        text: `Text: ${previewText(entry.text)}\nTotal voices: ${voices.length}`,
        footer: 'Select a voice model',
        nativeFlow: [{ text: 'Choose voice', sections }]
    }, m)
}

const selectVoice = async (m, conn, tts, text) => {
    const [token, value] = String(text || '').trim().split(/\s+/)
    const entry = pending.get(token)
    if (!entry) return m.reply('This voice menu has expired. Send the command again.')
    if (entry.sender !== m.sender) return m.reply('This voice menu belongs to another user.')

    const voice = tts.voices[Number(value) - 1]
    if (!voice) return m.reply('Invalid voice model.')

    try {
        const audio = await tts.speak(entry.text, voice.voice_id)
        await conn.sendMessage(m.chat, { audio, mimetype: 'audio/mpeg', ptt: false }, { quoted: m })
    } catch (error) {
        await m.reply(JSON.stringify({ error: error.message }))
    }
}

const handler = async (m, { conn, text, command, usedPrefix }) => {
    const tts = await global.scraper.get('tts')
    const prefix = usedPrefix || '.'

    if (command === 'ttsvoice') return selectVoice(m, conn, tts, text)

    if (!text) return m.reply(`Usage: ${prefix}tts <text>\nExample: ${prefix}tts Hello, my name is Rohan`)

    pruneExpired()
    const token = crypto.randomBytes(4).toString('hex')
    pending.set(token, { sender: m.sender, text, createdAt: Date.now() })
    try {
        await sendVoiceList(m, conn, tts.voices, token, prefix)
    } catch (error) {
        await m.reply(JSON.stringify({ error: error.message }))
    }
}

handler.help = ['tts <text>']
handler.description = 'Convert text to speech with a selectable voice model'
handler.tags = ['tools']
handler.command = ['tts', 'ttsvoice']
handler.limit = true
handler.platform = { whatsapp: { permission: [] }, discord: false }

export default handler
