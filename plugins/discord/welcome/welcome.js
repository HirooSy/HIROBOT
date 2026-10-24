function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const turnOff = (guild, reply, cfg) => {
  if (!cfg.get(guild.id)?.welcome) return reply({ ephemeral: true, content: 'Welcome messages are already off.' })
  cfg.set(guild.id, { welcome: null })
  return reply('Welcome messages turned off.')
}

let welcome = async (m, { args, conn }) => {
  if (typeof args.channel === 'string' && args.channel.toLowerCase() === 'off') return turnOff(m.guild, m.reply, conn.cfg)

  if (!args.channel) {
    const current = conn.cfg.get(m.guild.id)?.welcome
    if (!current?.channelId) {
      return m.reply({ ephemeral: true, content: 'Welcome messages are off. Use `welcome #channel [message]` to turn them on.' })
    }
    return m.reply({
      ephemeral: true,
      embeds: [conn.embed({
        title: 'Welcome messages',
        fields: [
          { name: 'Channel', value: `<#${current.channelId}>`, inline: true },
          { name: 'Message', value: clip(current.message || conn.cfg.welcome.default, 1000) }
        ]
      })]
    })
  }

  const target = await conn.find.channel(m.guild, args.channel)
  if (!conn.find.isText(target)) return m.reply({ ephemeral: true, content: 'Pick a text channel in this server.' })
  const text = args.message ? clip(String(args.message).trim(), 1000) : ''
  conn.cfg.set(m.guild.id, { welcome: { channelId: target.id, message: text || null } })
  return m.reply({
    ephemeral: true,
    embeds: [conn.embed({
      title: 'Welcome messages enabled',
      description: `New members will be greeted in <#${target.id}>.\nPlaceholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\``
    })]
  })
}

welcome.command = ['welcome']
welcome.description = 'Set the channel and message for new member greetings'
welcome.tags = ['Welcome']
welcome.permission = 'ManageGuild'
welcome.group = true
welcome.options = [
  { name: 'channel', description: 'Channel for welcome messages (or "off")', type: 'channel', channel_types: [0, 5] },
  { name: 'message', description: 'Text to send, {user} {username} {server} {count}', type: 'string' }
]

let welcomeoff = async (m, { conn }) => turnOff(m.guild, m.reply, conn.cfg)

welcomeoff.command = ['welcomeoff']
welcomeoff.description = 'Turn off welcome messages'
welcomeoff.tags = ['Welcome']
welcomeoff.permission = 'ManageGuild'
welcomeoff.group = true

export default [welcome, welcomeoff]
