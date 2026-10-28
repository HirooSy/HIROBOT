const { tiktok, tiktokBoostVolume, isLink } = global.scraper.tiktok;

let handler = async (m, { conn, args, command, platform }) => {
    const input = platform === 'discord' ? args.url : args[0]

    if (command == 'tiktok' || command == 'tt') {
        if (!input) throw '> Where The Url?'
        const link = isLink(input);
        if (!link) throw '> Invalid Url!'

        await m.react('⬇️')
        try {
            const data = await tiktok(link[0]);
            const caption = `- \`Author:\` ${data.author.nickname} ( @ ${data.author.unique_id} )${!data.title || data.title == '' ? '‎' : `\n- \`Description\`: \n> ${data.title}`}`

            if (platform === 'discord') {
                if (data.images) {
                    await conn.discord(m.chat, { image: data.images, text: caption })
                } else {
                    const videoUrl = data.play || data.hdplay || data.wmplay;
                    if (!videoUrl) throw new Error('No video URL from ssstik for this link');
                    const boostedBuffer = await tiktokBoostVolume(data.videos?.length ? data.videos : videoUrl);
                    await conn.discord(m.chat, { video: boostedBuffer, text: caption })
                }
            } else if (data.images) {
                await m.reply(caption)
                for (const img of data.images) conn.sendFile(m.chat, img, 'tiktok.png', null, null)
            } else {
                const videoUrl = data.play || data.hdplay || data.wmplay;
                if (!videoUrl) throw new Error('No video URL from ssstik for this link');
                const boostedBuffer = await tiktokBoostVolume(data.videos?.length ? data.videos : videoUrl);
                await conn.sendFile(m.chat, boostedBuffer, 'tiktok.mp4', caption, m)
            }
            m.react('✅')
        } catch (e) {
            m.error = e
            throw e
        }
    }

    if (command == 'tiktokaudio' || command == 'ttaudio') {
        if (!input) throw '> Where The Url?'
        const link = isLink(input);
        if (!link) throw '> Invalid Url!'

        await m.react('⬇️')
        try {
            const data = await tiktok(link[0]);
            if (platform === 'discord') {
                await conn.discord(m.chat, { audio: { url: data.music } })
            } else {
                const chat = db.data.chats[m.chat]
                await conn.sendFile(m.chat, data.music, 'tiktok.mp3', null, m, false, { mimetype: 'audio/mpeg', asDocument: chat.useDocument })
            }
            m.react('✅')
        } catch (e) {
            m.error = e
            throw e
        }
    }
}

handler.help = [
    ...['tiktok', 'tiktokaudio'].map(v => v + ' <url>'),
    { command: 'tiktok', name: 'url', description: 'TikTok video or photo URL', type: 'string', required: true },
    { command: 'tiktokaudio', name: 'url', description: 'TikTok URL to extract the audio from', type: 'string', required: true }
]
handler.tags = ['downloader']
handler.command = ['tiktok', 'tt', 'tiktokaudio', 'ttaudio']
handler.description = {
    tiktok: 'Download a TikTok video or photo post',
    tiktokaudio: 'Download the audio of a TikTok'
}
handler.limit = true
handler.ai = { risk: "low", description: "download tiktok post" }

handler.platform = { whatsapp: true, discord: true }

export default handler