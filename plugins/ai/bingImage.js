let handler = async (m, { conn, text, usedPrefix, command }) => {
    const { generateImage, ASPECT_RATIOS } = global.scraper['ai-image']
    let input = (text || m.quoted?.text || '').trim()
    let aspectRatio = '1:1'

    const match = input.match(/(?:^|\s)(?:--)?(1:1|3:2|2:3)(?=\s|$)/)
    if (match) {
        aspectRatio = match[1]
        input = input.replace(match[0], ' ').replace(/\s+/g, ' ').trim()
    }

    const prompt = input
    if (!prompt) throw `> Where The Prompt?\n\nExample: ${usedPrefix + command} an astronaut cat riding a skateboard\nRatio (optional): ${ASPECT_RATIOS.join(', ')}\nExample: ${usedPrefix + command} 3:2 mountain sunset`
    await m.react('⏳')

    try {
        const urls = await generateImage(prompt, { aspectRatio })
        if (!urls?.length) throw new Error('No image was returned by Bing.')

        try {
            await conn.aiRich()
                .addText(prompt)
                .addImage(urls, { resolveUrl: true })
                .send(m.chat, { quoted: m })
        } catch (richErr) {
            console.warn('[bingImage] aiRich failed, fallback sendFile:', richErr.message)
            for (const url of urls) await conn.sendFile(m.chat, url, 'bing.png', prompt, m)
        }

        await m.react('✅')
    } catch (e) {
        m.error = e
        throw e
    }
}

handler.help = ['bingimage [1:1|3:2|2:3] <prompt>']
handler.tags = ['ai']
handler.command = /^(bingimage|bingimg|bing)$/i
handler.limit = false

export default handler