import { spawn } from 'child_process'

let handler = async (m, { conn }) => {
    if (!process.send) throw 'Dont: node main.js\nDo: node start.js'
    if (process.env.DATABASE) await db.write()
    await new Promise(resolve => setTimeout(resolve, 2000))
    await m.reply('✦ Restarting...')
    process.send('reset')
}

handler.help = ['restart']
handler.tags = ['owner']
handler.command = /^(restart)$/i
handler.rowner = true

export default handler