const stickerly = global.scraper.stickerly

const STICKERLY_URL = /https?:\/\/(?:www\.)?sticker\.ly\/s\/([A-Za-z0-9]+)/i
const MAX_RESULTS = 10
const MAX_PER_PACK = 60

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) throw `Please enter a keyword or sticker link.\n\nExample:\n${usedPrefix + command} patrick\n${usedPrefix + command} https://sticker.ly/s/XXXXXX`

    const urlMatch = text.match(STICKERLY_URL)

    if (urlMatch) {
        const { pack } = await stickerly.getStickerPack(urlMatch[1])

        if (!pack.stickers.length) throw 'This sticker pack is empty.'

        const totalPacks = Math.ceil(pack.stickers.length / MAX_PER_PACK)

        for (let i = 0; i < totalPacks; i++) {
            const chunk = pack.stickers.slice(i * MAX_PER_PACK, (i + 1) * MAX_PER_PACK)

            await conn.sendStickerPack(m.chat, {
                cover: pack.trayImage ? { url: pack.trayImage } : undefined,
                stickers: chunk.map(s => ({ url: s.url, isAnimated: s.isAnimated })),
                name: totalPacks > 1 ? `${pack.name} (${i + 1}/${totalPacks})` : pack.name,
                publisher: pack.author || '',
                description: ''
            }, m)

            if (i < totalPacks - 1) await new Promise(resolve => setTimeout(resolve, 1000))
        }
        return
    }

    const { result, total } = await stickerly.searchStickerly(text, { limit: MAX_RESULTS })

    if (!total) return m.reply(`No stickers found for "${text}".`)

    const rows = result.map((pack, i) => ({
        header: `${i + 1}. ${pack.name}`.slice(0, 60),
        title: `${pack.stickersCount} stickers`.slice(0, 72),
        description: (pack.author?.name ? `by ${pack.author.name}` : '').slice(0, 72) || undefined,
        id: `${usedPrefix}stickerly ${pack.shareUrl}`
    }))

    await conn.sendButton(m.chat, {
        text: `- *Stickerly Search*\n- *Query:* ${text}\n- *Results:* ${result.length}\n\nSelect a sticker pack to download.`,
        footer: 'Stickerly',
        nativeFlow: [{ text: 'Select Pack', sections: [{ title: 'Result', rows }] }]
    }, m)
}

handler.help = ['stickerly <keyword/link>']
handler.tags = ['sticker']
handler.command = /^(stickerly)$/i
handler.ai = {
    risk: 'low',
    description: 'Search and download Sticker.ly sticker packs'
}

export default handler