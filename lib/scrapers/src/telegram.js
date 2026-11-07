import axios from 'hiro/axios'

const botToken = process.env.TELEGRAM_BOT_TOKEN || '7935827856:AAGdbLXArulCigWyi6gqR07gi--ZPm7ewhc'
const tgApi = `https://api.telegram.org/bot${botToken}`
const tgFile = `https://api.telegram.org/file/bot${botToken}`
const ua = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'

async function Telesticker(url) {
	try {
		const match = url.match(/https:\/\/t\.me\/addstickers\/([^\/\?#]+)/)
		if (!match) throw new Error('Invalid url')

		const { data: a } = await axios.get(`${tgApi}/getStickerSet?name=${match[1]}`, {
			headers: { 'user-agent': ua }
		})

		if (!a.ok) throw new Error('Sticker set not found')

		let skipped = 0

		const stickers = (await Promise.all(
			a.result.stickers.map(async (sticker) => {
				try {
					const { data: b } = await axios.get(`${tgApi}/getFile?file_id=${sticker.file_id}`, {
						headers: { 'user-agent': ua }
					})

					const filePath = b?.result?.file_path
					if (!filePath) { skipped++; return null }

					if (/\.tgs$/i.test(filePath)) { skipped++; return null }

					return {
						emoji: sticker.emoji,
						is_video: sticker.is_video || /\.webm$/i.test(filePath),
						is_animated: sticker.is_animated,
						url: `${tgFile}/${filePath}`
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
		throw "Can't get the sticker data, try another link"
	}
}

export { Telesticker }
