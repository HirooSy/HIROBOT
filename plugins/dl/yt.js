const { search: yts } = global.scraper.ytsearch
const { ytdl } = global.scraper.ytdl

const DISCORD_LIMIT = 24 * 1024 * 1024

function isLink(text) {
    return String(text || '').match(/https?:\/\/\S+/gi)
}

let handler = async (m, { conn, usedPrefix, text, command, platform }) => {
    if (/^yt(s|search)$/i.test(command)) {
        if (!text) throw '- *Example:* .yts <query>'
        const found = await yts(text)
        const data = found.all.filter(v => v.type == 'video').slice(0, 10)
        if (!data.length) return m.reply('No results found.')

        if (platform === 'discord') {
            const list = data.map((v, i) => `**${i + 1}.** ${v.title}\n${v.author.name} · ${v.timestamp} · ${v.ago}\n<${v.url}>`).join('\n\n')
            return conn.discord(m.chat, {
                embed: { title: `YouTube: ${text}`.slice(0, 256), description: list.slice(0, 4000) },
                select: [
                    {
                        placeholder: 'Download audio',
                        options: data.map(v => ({ label: v.title.slice(0, 100), description: `${v.author.name} · ${v.timestamp}`.slice(0, 100), action: `yta ${v.url}` }))
                    },
                    {
                        placeholder: 'Download video',
                        options: data.map(v => ({ label: v.title.slice(0, 100), description: `${v.author.name} · ${v.timestamp}`.slice(0, 100), action: `ytv ${v.url}` }))
                    }
                ]
            })
        }

        const res = data.map((v, i) => `> [ ${i + 1} ] ${v.title}\n- *Author:* ${v.author.name}\n- *Publish:* ${v.ago}\n- *Duration:* ${v.timestamp}\n- *Views:* ${(parseInt(v.views)).toSimpleNumber()}\n- ${(v.url).replace('https://', '')}`).join('\n\n')
        return conn.reply(m.chat, res, { key: { fromMe: false, participant: m.sender, ...(m.chat ? { remoteJid: '16504228206@s.whatsapp.net' } : {}) }, message: { contactMessage: { displayName: 'YOUTUBE SEARCH', vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;a,;;;\nFN:${await conn.getName(m.sender)}\nitem1.TEL;waid=6283143393763:6283143393763\nitem1.X-ABLabel:Mobile\nEND:VCARD` } } })
    }

    const links = isLink(text)
    if (!text || !links) return m.reply(`*How To Use:* \`${usedPrefix + command} <your_link>\`\n\nExample: \`${usedPrefix + command} https://youtube.com/watch?v=xxxx\``)
    const isAudio = /yt(a|audio|mp3)/i.test(command)
    try {
        const data = await ytdl(isAudio ? 'audio' : 'video', links[0])
        const filename = isAudio ? 'YouTube.mp3' : 'YouTube.mp4'
        if (platform === 'discord') {
            if (data.buffer.length > DISCORD_LIMIT) return m.reply('The file is too large to upload on Discord.')
            return conn.discord(m.chat, { [isAudio ? 'audio' : 'video']: data.buffer, fileName: filename })
        }
        await conn.sendMessage(m.chat, {
            [isAudio ? 'audio' : 'video']: data.buffer,
            mimetype: data.mime,
            asDocument: db.data.chats[m.chat].useDocument,
            fileName: filename
        }, { quoted: m })
    } catch (e) {
        return m.reply('Failed to download, Scrape trouble')
    }
}

handler.help = [
    'ytv <link>', 'yta <link>', 'yts <query>',
    { command: 'yta', name: 'text', description: 'YouTube link to download as audio', type: 'string', required: true },
    { command: 'ytv', name: 'text', description: 'YouTube link to download as video', type: 'string', required: true },
    { command: 'yts', name: 'text', description: 'What to search on YouTube', type: 'string', required: true }
]
handler.tags = ['downloader']
handler.command = ['yta', 'ytaudio', 'ytmp3', 'ytv', 'ytvideo', 'ytmp4', 'yts', 'ytsearch']
handler.description = {
    yta: 'Download the audio of a YouTube video',
    ytv: 'Download a YouTube video',
    yts: 'Search videos on YouTube'
}
handler.limit = true
handler.ai = { risk: 'low', description: 'download music or video from youtube' }

handler.platform = { whatsapp: true, discord: true }

export default handler
