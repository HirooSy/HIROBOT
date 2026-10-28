const VALID = /^[^\s<>@`\\]{1,5}$/
const RESET = ['reset', 'default', 'off']

const listOf = list => list.map(p => `\`${p}\``).join(' ')

let handler = async (m, { args, conn, usedPrefix, platform }) => {
  if (platform !== 'discord') {
    const chat = db.data.chats[m.chat]
    const wanted = String(args[0] ?? '').trim()
    const active = chat.prefix || ''

    if (!wanted) {
      return m.reply(active
        ? `This chat uses \`${active}\` as its prefix.\n\nChange it: ${usedPrefix}prefix <value>\nReset it: ${usedPrefix}prefix reset`
        : `This chat uses the default prefixes.\n\nChange it: ${usedPrefix}prefix <value>`)
    }
    if (RESET.includes(wanted.toLowerCase())) {
      if (!active) return m.reply('This chat already uses the default prefixes.')
      chat.prefix = ''
      return m.reply('Prefix reset. This chat uses the default prefixes again.')
    }
    if (!VALID.test(wanted)) return m.reply('A prefix must be 1 to 5 characters with no spaces, <, >, @, backticks or backslashes.')
    if (wanted === active) return m.reply(`The prefix is already \`${wanted}\`.`)
    chat.prefix = wanted
    return m.reply(`Prefix changed to \`${wanted}\`. The default prefixes no longer work in this chat, but \`${wanted}prefix reset\` or the default prefix with \`prefix reset\` still does.`)
  }

  const current = conn.cfg.prefix.get(m.guild.id)
  const value = args.value === undefined || args.value === null ? '' : String(args.value).trim()

  if (!value) {
    const description = current
      ? `This server uses \`${current}\` as its prefix.`
      : `This server uses the default prefixes: ${listOf(conn.cfg.prefix.list(null))}.`
    return m.reply({
      ephemeral: true,
      embeds: [conn.embed({
        title: 'Command prefix',
        description,
        fields: [{ name: 'Change it', value: `\`${usedPrefix}prefix <value>\` to set, \`${usedPrefix}prefix reset\` to restore the default.` }]
      })]
    })
  }

  if (RESET.includes(value.toLowerCase())) {
    if (!current) return m.reply({ ephemeral: true, content: 'This server already uses the default prefixes.' })
    conn.cfg.prefix.set(m.guild.id, null)
    return m.reply(`Prefix reset. This server uses the default prefixes again: ${listOf(conn.cfg.prefix.list(null))}`)
  }

  if (!VALID.test(value)) {
    return m.reply({ ephemeral: true, content: 'A prefix must be 1 to 5 characters with no spaces, mentions, `<`, `>`, `@`, backticks or backslashes.' })
  }
  if (value === current) return m.reply({ ephemeral: true, content: `The prefix is already \`${value}\`.` })

  conn.cfg.prefix.set(m.guild.id, value)
  const mention = conn.client?.user?.id ? `<@${conn.client.user.id}>` : 'the bot'
  return m.reply(`Prefix changed to \`${value}\`. Default prefixes no longer work in this server, use ${mention} or slash commands.`)
}

handler.command = ['prefix']
handler.description = 'Show or change the command prefix for this server or chat'
handler.tags = ['Settings']
handler.group = true
handler.help = [
  { name: 'value', description: 'New prefix (1-5 characters), or "reset"', type: 'string' }
]

handler.anyPrefix = true

handler.platform = { whatsapp: { permission: ['admin'] }, discord: { permission: ['manageServer'] } }

export default handler

