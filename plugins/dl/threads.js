const sendOut = (conn, m, platform, payload) => platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m })

let handler = async (m, { conn, usedPrefix, command, text, platform }) => {
    if (!text) return m.reply(`*Example:* ${usedPrefix + command} <Threads_link>`)

    let data
    try {
        data = await global.scraper.threads.get(text.trim())
    } catch (err) {
        return m.reply(`- Failed to get post data.\n- Debug: ${err.message}`)
    }

    for (const media of data.medias) {
        if (media.type === 'video') {
            const caption = `- *Resolution:* ${media.resolution}\n- *Duration:* ${media.duration || '-'}`
            await sendOut(conn, m, platform, { video: { url: media.url }, caption })
        } else {
            await sendOut(conn, m, platform, { image: { url: media.url } })
        }
    }
}

handler.tags = ['downloader']
handler.help = [
    'threads <link>',
    { command: 'threads', name: 'text', description: 'Threads post link', type: 'string', required: true }
]
handler.command = ['threads', 'threadsdl']
handler.description = 'Download video or images from a Threads post'
handler.limit = true
handler.platform = { whatsapp: true, discord: true }

export default handler