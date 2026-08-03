import { spawn } from 'child_process'

let handler = async (m, { conn }) => {
    if (process.env.DATABASE) {
        let { key } = await m.reply("Saving Database...")
        await db.write()
        await new Promise(resolve => setTimeout(resolve, 2000))
        await conn.sendMessage(m.chat, { text: "Restarting...", edit: key })
        } else { await m.reply('✦ Restarting...') }

    process.send('reset')
}

handler.help = ['restart']
handler.tags = ['owner']
handler.command = /^(restart)$/i
handler.rowner = true

export default handler
