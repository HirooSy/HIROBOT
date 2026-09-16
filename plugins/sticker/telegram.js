import axios from 'axios'

const BOT_TOKEN = '7935827856:AAGdbLXArulCigWyi6gqR07gi--ZPm7ewhc'
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'

var handler = async (m, { conn, args }) => {
	if (!args[0] || !args[0].match(/(https:\/\/t\.me\/addstickers\/)/gi)) throw 'Input Telesticker Url'

	let result = await Telesticker(args[0])
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

export default handler

async function Telesticker(url) {
	try {
		const match = url.match(/https:\/\/t\.me\/addstickers\/([^\/\?#]+)/)
		if (!match) throw new Error('Invalid url')

		const { data: a } = await axios.get(`${TG_API}/getStickerSet?name=${match[1]}`, {
			headers: { 'user-agent': UA }
		})

		if (!a.ok) throw new Error('Sticker set not found')

		let skipped = 0

		const stickers = (await Promise.all(
			a.result.stickers.map(async (sticker) => {
				try {
					const { data: b } = await axios.get(`${TG_API}/getFile?file_id=${sticker.file_id}`, {
						headers: { 'user-agent': UA }
					})

					const filePath = b?.result?.file_path
					if (!filePath) { skipped++; return null }

					if (/\.tgs$/i.test(filePath)) { skipped++; return null }

					return {
						emoji: sticker.emoji,
						is_video: sticker.is_video || /\.webm$/i.test(filePath),
						is_animated: sticker.is_animated,
						url: `${TG_FILE}/${filePath}`
					}
				} catch (e) {
					skipped++
					return null
				}
			})
		)).filter(Boolean)

		return {
			name: a.result.name,
			title: a.result.title,
			link: `t.me/addstickers/${match[1]}`,
			sticker_type: a.result.sticker_type,
			stickers,
			skipped
		}
	} catch (error) {
		console.error(error.message)
		throw "Can't get the sticker data, try another link"
	}
}