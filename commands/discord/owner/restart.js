let handler = async (m, { conn }) => {
  if (process.env.DATABASE) {
    await m.reply({ ephemeral: true, content: 'Saving database...' })
    await conn.db.write().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1500))
  } else {
    await m.reply({ ephemeral: true, content: 'Restarting...' })
  }
  if (typeof process.send === 'function') process.send('reset')
  else process.exit(0)
}

handler.command = ['restart']
handler.description = 'Restart the bot'
handler.tags = ['Owner']
handler.owner = true

export default handler

