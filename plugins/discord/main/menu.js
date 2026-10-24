const ORDER = ['Info', 'Utility', 'Moderation', 'Roles', 'Welcome', 'Settings', 'Server', 'Music', 'AI', 'Downloader', 'Tools', 'Owner']

let handler = async (m, { args, isOwner, usedPrefix, conn }) => {
  const view = { owner: isOwner, inGuild: m.isGroup, guild: m.guild, member: m.member, args: {} }
  const visible = [...conn.commands.values()].filter(cmd => !cmd.hidden && (isOwner || !cmd.owner) && !conn.cfg.access.denial(cmd, view))

  const accessOf = cmd => {
    if (cmd.owner) return 'Owner only'
    const ids = m.guild ? conn.cfg.access.roles(m.guild.id, cmd.name) : []
    if (ids.length) return ids.map(id => `<@&${id}>`).join(' ')
    if (cmd.permission && typeof cmd.permission !== 'function') return [].concat(cmd.permission).map(conn.roles.label).join(' and ')
    return 'Everyone'
  }

  if (args.command) {
    const query = String(args.command).toLowerCase().replace(/^[./!]/, '')
    const cmd = visible.find(c => c.name === query || c.aliases?.includes(query) || (typeof c.match === 'function' && c.match(query)))
    if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
    const fields = [{ name: 'Usage', value: `\`${usedPrefix}${cmd.usage || cmd.name}\`` }]
    if (cmd.aliases?.length) fields.push({ name: 'Aliases', value: cmd.aliases.map(a => `\`${a}\``).join(' '), inline: true })
    if (cmd.limit) fields.push({ name: 'Limit', value: String(Number(cmd.limit) || 1), inline: true })
    fields.push({ name: 'Access', value: accessOf(cmd), inline: true })
    return m.reply({ ephemeral: true, embeds: [conn.embed({ title: cmd.name, description: cmd.description, fields })] })
  }

  const groups = new Map()
  for (const cmd of visible) {
    const category = cmd.category || 'Other'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(cmd.name)
  }

  const names = [...groups.keys()].sort((a, b) => {
    const x = ORDER.indexOf(a)
    const y = ORDER.indexOf(b)
    return (x === -1 ? 99 : x) - (y === -1 ? 99 : y) || a.localeCompare(b)
  })

  const fields = names.map(category => {
    const list = groups.get(category).sort().map(n => `\`${n}\``).join(' ')
    return { name: `${category} (${groups.get(category).length})`, value: list.length > 1024 ? `${list.slice(0, 1020)}…` : list }
  })

  const prefixes = conn.cfg.prefix.list(m.guild?.id ?? null).map(p => `\`${p}\``).join(' ')
  return m.reply({
    ephemeral: true,
    embeds: [conn.embed({
      title: `${global.settings.botname} commands`,
      description: `Prefix: ${prefixes}  •  Slash: \`/\`\nUse \`${usedPrefix}menu <command>\` for details. Commands you cannot use are hidden.`,
      fields
    })]
  })
}

handler.command = ['menu', 'help', '?']
handler.description = 'Show all available commands'
handler.tags = ['Info']
handler.options = [{ name: 'command', description: 'Show details for one command', type: 'string' }]

export default handler
