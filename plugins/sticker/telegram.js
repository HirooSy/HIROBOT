var handler = async (m, { conn, args, text, usedPrefix, command }) => {
	if (!args[0]) throw `- *Example:*\n> ${usedPrefix + command} prabowo\n> ${usedPrefix + command} https://t.me/addstickers/<name>`

	if (!/https:\/\/t\.me\/addstickers\//i.test(args[0])) {
		const packs = await global.scraper.telegram.Telesearch(text)
		if (!packs.length) throw `> No sticker pack found for *${text}*`

		const rows = packs.map((pack, i) => ({
			header: `${i + 1}. ${pack.title || 'Untitled'}`.slice(0, 60),
			title: pack.telegramUrl.split('/').pop().slice(0, 24),
			description: String(pack.status || 'Telegram pack').slice(0, 72),
			id: `${usedPrefix}stele ${pack.telegramUrl}`
		}))

		return conn.sendButton(m.chat, {
			text: `- *Sticker Search*\n- *Query:* ${text}\n- *Results:* ${packs.length}\n\nSelect the pack you want to download.`,
			footer: 'Telegram Stickers',
			nativeFlow: [{ text: 'Select Pack', sections: [{ title: 'Result', rows }] }]
		}, m)
	}

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

handler.help = ['stele <query>', 'stele <url>']
handler.tags = ['sticker']
handler.command = /^(telestic?ker|stic?kertele|stele)$/i
handler.limit = 1

handler.platform = { whatsapp: true, discord: false }

export default handler