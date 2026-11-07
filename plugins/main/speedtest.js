let handler = async (m, { conn, platform }) => {
    await m.react("🔴")

    try {
        const r = await global.scraper.speedtest.runSpeedtest()

        const dl = (r.download / 1e6).toFixed(2)
        const ul = (r.upload / 1e6).toFixed(2)
        const ping = r.ping.toFixed(2)
        const dist = r.server.d.toFixed(2)

        const text =
`> \`\`\`Testing From ${r.isp}\`\`\`

────────────────
- *\`Hosted :\`* ${r.server.sponsor}
- *\`Location :\`* ${r.server.name}, ${r.server.country} [${dist} km]
- *\`Ping :\`* ${ping} ms
- ▾ *\`Inbound :\`* ${dl} Mb/s
- ▵ *\`Outbound :\`* ${ul} Mb/s

────────────────`

        if (platform === 'discord') {
            await conn.discord(m.chat, { text: text.replace(/\*`([^`]+)`\*/g, '**$1**') })
            await m.react("🟢")
            return
        }

        await conn.reply(m.chat, text, {
            key: { remoteJid: "0@s.whatsapp.net" },
            message: {
                orderMessage: {
                    orderId: '780642630945098',
                    thumbnail: await conn.resize(img.profile.bot, 150, 150),
                    itemCount: 666,
                    status: 1,
                    surface: 1,
                    message: "𝗦𝗣𝗘𝗘𝗗𝗧𝗘𝗦𝗧 . Ookla",
                    orderTitle: 'Channel.',
                    sellerJid: '6283143393763@s.whatsapp.net',
                    token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==',
                    totalAmount1000: "0",
                    totalCurrencyCode: "IDR"
                }
            }
        })

        await m.react("🟢")

    } catch (e) {
        await m.reply(`❌ Speedtest failed:\n${e.message}`)
        await m.react("🔴")
    }
}

handler.help = ["speedtest"]
handler.tags = ['info']
handler.command = ['speedtest']
handler.description = 'Run a speed test from the bot server'
handler.ai = { risk: 'low', summarize: true, description: "Check speed response bot" }

handler.platform = { whatsapp: true, discord: true }

export default handler
