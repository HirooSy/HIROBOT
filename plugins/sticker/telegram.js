var handler = async (m, { conn, args }) => {
	if (!args[0] || !args[0].match(/(https:\/\/t\.me\/addstickers\/)/gi)) throw 'Input Telesticker Url'

	let result = await global.scraper.telegram.Telesticker(args[0])
	let stickers = result.stickers
	if (!stickers || stickers.length === 0) return "Can't get sticker data, try another link"
	if (stickers.length > 300) return m.reply(`[ *${stickers.length}* Stickers ] Request cancelled, too risk for bot.`)

	if (result.skipped > 0) {
		await m.reply(`⚠️ ${result.skipped} sticker(s) skipped (unsupported animated format).`)
	}

	const maxStickersPerPack = 60
	const totalPacks = Math.ceil(stickers.length / maxStickersPerPack)

	for (let packIndex = 0; packIndex < totalPacks; packIndex++) {
		let start = packIndex * maxStickersPerPack
		let end = Math.min(start + maxStickersPerPack, stickers.length)
		let packStickers = stickers.slice(start, end)

		let stickerPack = packStickers.map(s => ({
			data: { url: s.url }
		}))

		let packName = totalPacks > 1
			? `${result.title} (${packIndex + 1}/${totalPacks})`
			: result.title

		let packDescription = `${global.settings.botname} — ${global.opts.server}`

		await conn.sendStickerPack(m.chat, {
			cover: { url: packStickers[0].url },
			stickers: stickerPack,
			name: packName,
			publisher: result.link,
			description: packDescription
		}, m)

		if (packIndex < totalPacks - 1) {
			await new Promise(resolve => setTimeout(resolve, 1000))
		}
	}
}

handler.help = ["telesticker <url>"]
handler.tags = ['sticker']
handler.command = /^(telestic?ker|stic?kertele|stele)$/i
handler.limit = 3

handler.platform = { whatsapp: true, discord: false }

export default handler
