import { tiktok, tiktokBoostVolume, isLink } from '../../lib/scraper/tiktok.js';

let handler = async (m, { conn, args, command }) => {

    if (command == 'tiktok' || command == 'tt') {
        if (!args[0]) throw '> Where The Url?'
        const link = isLink(args[0]);
        if (!link) throw '> Invalid Url!'

        await m.react('⬇️')
        try {
            const data = await tiktok(link[0]);
            const caption = `- \`Author:\` ${data.author.nickname} ( @ ${data.author.unique_id} )${!data.title || data.title == '' ? '‎' : `\n- \`Description\`: \n> ${data.title}`}`

            if (data.images) {
                await m.reply(caption)
                for (const img of data.images) conn.sendFile(m.chat, img, 'tiktok.png', null, null)
            } else {
                const boostedBuffer = await tiktokBoostVolume(data.play);
                await conn.sendFile(m.chat, boostedBuffer, 'tiktok.mp4', caption, m)
            }
            m.react('✅')
        } catch (e) {
            m.error = e
            throw e
        }
    }

    if (command == 'tiktokaudio' || command == 'ttaudio') {
        if (!args[0]) throw '> Where The Url?'
        const link = isLink(args[0]);
        if (!link) throw '> Invalid Url!'

        const chat = db.data.chats[m.chat]
        await m.react('⬇️')
        try {
            const data = await tiktok(link[0]);
            await conn.sendFile(m.chat, data.music, 'tiktok.mp3', null, m, false, { mimetype: 'audio/mpeg', asDocument: chat.useDocument })
            m.react('✅')
        } catch (e) {
            m.error = e
            throw e
        }
    }
}

handler.help = ['tiktok', 'tiktokaudio'].map(v => v + ' <url>')
handler.tags = ['downloader']
handler.dym = ['tiktok', 'tiktokaudio']
handler.command = /^(tt|tiktok)(audio)?$/i
handler.limit = true
handler.ai = { risk: "low", description: "download tiktok post" }

export default handler
