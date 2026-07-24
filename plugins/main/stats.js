let handler = async (m, { conn }) => {
    let chat = db.data.chats[m.chat] || {}
    let bot = db.data.settings[conn.user.jid] || {}
    let y = "■"
    let n = "□"

    // Helper buat format teks dari objek
    let format = (obj) => Object.keys(obj)
        .filter(k => typeof obj[k] === 'boolean')
        .map(k => `「${obj[k] ? y : n}」 ${k.charAt(0).toUpperCase() + k.slice(1)}`)
        .join('\n')

    // Filter khusus untuk bot agar lebih bersih
    let botKeys = {
        self: bot.self,
        autoread: bot.autoread,
        restrict: bot.restrict,
        clearsesi: bot.clearsesi,
        clearstore: bot.clearstore,
        jadibot: bot.jadibot
    }
    
    // Tambahkan opts yang global
    let globalKeys = {
        gconly: global.opts['gconly'],
        pconly: global.opts['pconly'],
        swonly: global.opts['swonly']
    }

    let teks = `*𝗖𝗢𝗡𝗙𝗜𝗚 𝗕𝗢𝗧*\n${format(botKeys)}\n${format(globalKeys)}\n\n*𝗖𝗢𝗡𝗙𝗜𝗚 𝗖𝗛𝗔𝗧*\n${format(chat)}`

    m.reply(teks)
}

handler.help = ["liststats"]
handler.tags = ['info']
handler.command = /^((list)?(stats|config))$/i
handler.ai = { risk: 'low', description: "Check bot settings" }

export default handler
