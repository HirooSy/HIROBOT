let handler = async (m, { conn, usedPrefix: _p, command, text, args, platform }) => {
    if (platform === 'discord') {
        if (command === 'setbye') return m.reply({ ephemeral: true, content: 'Goodbye messages are not available on Discord.' })
        const welcome = conn.cfg.get(m.guild.id)?.welcome
        if (!welcome?.channelId) return m.reply({ ephemeral: true, content: 'Turn welcome messages on first with `enable welcome #channel`.' })
        const message = String(args.text || '').trim().slice(0, 1000)
        if (!message) return m.reply({ ephemeral: true, content: 'Give the welcome text. Placeholders: `{user}` `{username}` `{server}` `{count}`' })
        conn.cfg.set(m.guild.id, { welcome: { ...welcome, message } })
        return m.reply('Welcome message updated.')
    }

    let chat = db.data.chats[m.chat]
    if (/setwelcome/i.test(command)) {
        if (!text) return m.reply(`
> Usage example: ${_p + command} <text & options>
> *Options :*
  - @user
  - @subject
  - @decription

> *Text example:*
   Welcome To @subject, @user!`)
        m.reply('successfully applied as welcome')
        chat.sWelcome = text
    }

    if (/setbye/i.test(command)) {
        if (!text) return m.reply(`
> Usage example: ${_p + command} <text & options>
> *Options :*
  - @user
  - @subject
  - @decription

> *Text example:*
   Bye @user!`)
        m.reply('successfully applied as bye')
        chat.sBye = text
    }
}
handler.help = [
    ...['setbye', 'setwelcome'].map(v => v + ' <text>'),
    { command: 'setwelcome', name: 'text', description: 'Welcome text: {user} {username} {server} {count}', type: 'string', required: true }
]
handler.tags = ['owner']
handler.command = ['setwelcome', 'setbye']
handler.description = 'Set the message sent to new members'
handler.group = true

handler.platform = { whatsapp: { permission: ['admin'] }, discord: { permission: ['manageServer'] } }

export default handler
