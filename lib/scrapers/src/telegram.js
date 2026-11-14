import axios from 'hiro/axios'

const botToken = '8385310894:AAFCpqi2J1lQXM4mZarEbX-TeZNm7igj9HQ'
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
		console.error(error.message)
		throw "Can't get the sticker data, try another link"
	}
}

const sigstickHeaders = {
	'user-agent': ua,
	'sec-ch-ua': '"Chromium";v="139", "Not;A=Brand";v="99"',
	'sec-ch-ua-mobile': '?1',
	'sec-ch-ua-platform': '"Android"'
}

async function sigstickBuildId() {
	const { data: html } = await axios.get('https://www.sigstick.com/stickers', { headers: sigstickHeaders })
	const match = String(html).match(/"buildId":"([a-zA-Z0-9_-]+)"/) || String(html).match(/data-build-id="([a-zA-Z0-9_-]+)"/)
	if (!match) throw new Error('Build ID not found')
	return match[1]
}

async function Telesearch(keyword) {
	try {
		const buildId = await sigstickBuildId()
		const { data } = await axios.get(`https://www.sigstick.com/_next/data/${buildId}/stickers.json`, {
			params: { keyword },
			headers: {
				...sigstickHeaders,
				'x-nextjs-data': '1',
				'Referer': `https://www.sigstick.com/stickers?keyword=${encodeURIComponent(keyword)}`
			}
		})
		return (data?.pageProps?.packs || []).filter(pack => /t\.me\/addstickers\//i.test(pack.telegramUrl || ''))
	} catch (error) {
		throw "Can't search sticker packs, try again later"
	}
}

export { Telesticker, Telesearch }
