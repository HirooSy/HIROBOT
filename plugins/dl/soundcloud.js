const isLink = text => /^https?:\/\/|soundcloud\.com|snd\.sc/i.test(text.trim())

const formatDuration = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

async function searchTracks(m, { conn, usedPrefix, command, text, platform }) {
    let tracks
    try {
        tracks = await global.scraper.soundcloud.search(text.trim())
    } catch (err) {
        return m.reply(`- Failed to search tracks.\n- Debug: ${err.message}`)
    }

    if (!tracks.length) return m.reply(`> No track found for *${text}*`)

    if (platform === 'discord') {
        const list = tracks.map((track, i) => `${i + 1}. **${track.title || 'Untitled'}** - ${track.artist || '-'}\n${track.permalink_url}`).join('\n\n')
        return m.reply(`**Search:** ${text}\n\n${list}`)
    }

    const rows = tracks.map((track, i) => ({
        header: `${i + 1}. ${track.title || 'Untitled'}`.slice(0, 60),
        title: (track.artist || 'Unknown Artist').slice(0, 24),
        description: `${formatDuration(track.duration_sec)} · ${track.playback_count ?? '-'} plays`.slice(0, 72),
        id: `${usedPrefix + command} ${track.permalink_url}`
    }))

    return conn.sendButton(m.chat, {
        text: `Select the track you want to download.`,
        footer: `Result: ${rows.length}`,
        nativeFlow: [{ text: 'Select Track', sections: [{ title: 'Result', rows }] }]
    }, m)
}

let handler = async (m, { conn, usedPrefix, command, text, platform }) => {
    if (!text) return m.reply(`- *Download:* ${usedPrefix + command} <SoundCloud_link>\n- *Search:* ${usedPrefix + command} <query>`)
    if (!isLink(text)) return searchTracks(m, { conn, usedPrefix, command, text, platform })

    let data
    try {
        data = await global.scraper.soundcloud.get(text.trim())
    } catch (err) {
        return m.reply(`- Failed to get track data.\n- Debug: ${err.message}`)
    }

    if (data.kind !== 'track') return m.reply('- Only single track links can be downloaded.')

    const source = data.download
    if (!source) return m.reply('- Failed to get track data.\n- Debug: no playable stream found.')

    const title = data.title || 'Unknown Title'
    const fileName = `${data.artist ? `${data.artist} - ` : ''}${title}`.replace(/[\\/:*?"<>|]/g, '').slice(0, 120) + '.mp3'

    let audio = source
    if (/\.m3u8/i.test(source)) {
        try {
            audio = await global.scraper.soundcloud.hlsToMp3(source)
        } catch (err) {
            return m.reply(`- Failed to get track data.\n- Debug: ${err.message}`)
        }
    }

    if (platform === 'discord') {
        return conn.discord(m.chat, { audio, fileName, text: `**${title}**` })
    }

    const duration = data.duration_sec || 0
    const caption = `- *Title:* ${title}\n- *Artist:* ${data.artist || '-'}\n- *Duration:* ${formatDuration(duration)}\n- *Plays:* ${data.playback_count ?? '-'}`

    return conn.sendFile(m.chat, audio, fileName, caption, m, false, {
        mimetype: 'audio/mpeg',
        asDocument: db.data.chats[m.chat]?.useDocument
    })
}

handler.tags = ['downloader']
handler.help = [
    'soundcloud <link>',
    'soundcloud <query>',
    { command: 'soundcloud', name: 'text', description: 'SoundCloud track link or search query', type: 'string', required: true }
]
handler.command = ['soundcloud', 'scdl']
handler.description = 'Download a track from SoundCloud or search for tracks'
handler.limit = true
handler.platform = { whatsapp: true, discord: true }

export default handler