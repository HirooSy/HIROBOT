import axios from 'axios'

var handler = async (m, { conn, args }) => {
	if (args[0] && args[0].match(/(https:\/\/t.me\/addstickers\/)/gi)) {
		let result = await Telesticker(args[0])
		let stickers = result.stickers
		if (!stickers || stickers.length === 0) return "Can\'t get sticker data, try another link"
		if (stickers.length > 300) return m.reply(`[ *${stickers.length}* Stickers ] Request cancelled, too risk for bot.`)
		
		const maxStickersPerPack = 10
		if (stickers.length <= 60) {
			let stickerPack = []
			for (let i = 0; i < stickers.length; i++) {
				stickerPack.push({
					data: {
						url: stickers[i].url
					}
				})
			}
			
			await conn.sendMessage(m.chat, {
				cover: {
					url: stickers[0].url 
				},
				stickers: stickerPack,
				name: `${result.title}`,
				publisher: '',
				description: ``
			}, {
				quoted: m
			})
			
		} 
		
		else {
			let totalPacks = Math.ceil(stickers.length / maxStickersPerPack)
			
			for (let packIndex = 0; packIndex < totalPacks; packIndex++) {
				let start = packIndex * maxStickersPerPack
				let end = Math.min(start + maxStickersPerPack, stickers.length)
				let packStickers = stickers.slice(start, end)
				
				let stickerPack = []
				for (let i = 0; i < packStickers.length; i++) {
					stickerPack.push({
						data: {
							url: packStickers[i].url
						}
					})
				}
				
				await conn.sendMessage(m.chat, {
					cover: {
						url: packStickers[0].url 
					},
					stickers: stickerPack,
					name: `${result.title} (${packIndex + 1}/${totalPacks})`,
					publisher: ``,
					description: ``
				}, {
					quoted: m
				})
				
				if (packIndex < totalPacks - 1) {
					await new Promise(resolve => setTimeout(resolve, 1000))
				}
			}
			
		}
	} else throw 'Input Telesticker Url'
}

handler.help = handler.dym = ['telesticker']
handler.tags = ['sticker']
handler.command = /^(telestic?ker|stic?kertele|stele)$/i
handler.limit = 5
handler.level = 1

export default handler

async function Telesticker(url) {
    try {
        const match = url.match(/https:\/\/t\.me\/addstickers\/([^\/\?#]+)/);
        if (!match) throw new Error('Invalid url');
        
        const { data: a } = await axios.get(`https://api.telegram.org/bot7935827856:AAGdbLXArulCigWyi6gqR07gi--ZPm7ewhc/getStickerSet?name=${match[1]}`, {
            headers: {
                'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
            }
        });
        
        const stickers = await Promise.all(
            a.result.stickers.map(async (sticker) => {
                const { data: b } = await axios.get(`https://api.telegram.org/bot7935827856:AAGdbLXArulCigWyi6gqR07gi--ZPm7ewhc/getFile?file_id=${sticker.file_id}`, {
                    headers: {
                        'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
                    }
                });
                
                return {
                    emoji: sticker.emoji,
                    is_animated: sticker.is_animated,
                    url: `https://api.telegram.org/file/bot7935827856:AAGdbLXArulCigWyi6gqR07gi--ZPm7ewhc/${b.result.file_path}`
                }
            })
        );
        
        return {
            name: a.result.name,
            title: a.result.title,
            sticker_type: a.result.sticker_type,
            stickers: stickers
        };
    } catch (error) {
        console.error(error.message);
        throw "Can\'t get the sticker data, try another link"
    }
}