import { spawn } from 'child_process'

let handler = async (m, { conn, platform }) => {
  if (platform == 'discord') {
    if (process.env.DATABASE) {
      await m.reply({ ephemeral: true, content: 'Saving database...' })
      await conn.db.write().catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 1500))
    } else {
      await m.reply({ ephemeral: true, content: 'Restarting...' })
    }
    if (typeof process.send === 'function') process.send('reset')
    else process.exit(0)
    return
  }
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
handler.command = ['restart']
handler.description = 'Restart the bot'
handler.platform = { whatsapp: { permission: ['rowner'] }, discord: { permission: ['rowner'] } }

export default handler
