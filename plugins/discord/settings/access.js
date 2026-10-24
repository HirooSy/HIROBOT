function summaryOf(cmd, guildId, cfg, roles) {
  const ids = cfg.access.roles(guildId, cmd.name)
  if (ids.length) {
    return `Only members with one of these roles can use it: ${ids.map(id => `<@&${id}>`).join(' ')}. Server admins and bot owners can always use it.`
  }
  if (cfg.access.locked.has(cmd.name)) return 'Needs the Manage Server permission. Role access cannot change this.'
  if (cmd.owner) return 'Bot owners only.'
  if (typeof cmd.permission === 'function') return 'Everyone can use it, but some options need a permission.'
  if (cmd.permission) return `Needs the ${[].concat(cmd.permission).map(roles.label).join(' and ')} permission.`
  return 'Everyone can use it.'
}

let handler = async (m, { args, conn, usedPrefix }) => {
  const query = String(args.command ?? '').trim()
  if (query) {
    const cmd = conn.find.command(query)
    if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${conn.find.commandName(query)}\` was not found.` })
    return m.reply({ ephemeral: true, embeds: [conn.embed({ title: `Access: ${cmd.name}`, description: summaryOf(cmd, m.guild.id, conn.cfg, conn.roles) })] })
  }

  const names = Object.keys(conn.cfg.access.rules(m.guild.id)).sort()
  const lines = names.map(name => `\`${name}\` → ${conn.cfg.access.roles(m.guild.id, name).map(id => `<@&${id}>`).join(' ')}`)
  const body = lines.length ? lines.join('\n') : 'No command is restricted. Every command uses its default permission.'
  return m.reply({
    ephemeral: true,
    embeds: [conn.embed({
      title: 'Command access',
      description: `${body.slice(0, 3400)}\n\nUse \`${usedPrefix}allow <role> <command>\` to restrict a command, \`${usedPrefix}disallow <role> <command>\` to remove a role, and \`${usedPrefix}resetaccess <command>\` to clear it.`
    })]
  })
}

handler.command = ['access']
handler.description = 'Show which roles can use each command in this server'
handler.tags = ['Settings']
handler.permission = 'ManageGuild'
handler.group = true
handler.options = [
  { name: 'command', description: 'Command to check, leave empty to list every restriction', type: 'string' }
]

export default handler
