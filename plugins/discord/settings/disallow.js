let handler = async (m, { args, conn }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })

  const query = conn.find.commandName(args.command)
  const cmd = conn.find.command(query)
  if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
  if (conn.cfg.access.locked.has(cmd.name)) {
    return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so its access cannot be changed.` })
  }

  const current = conn.cfg.access.roles(m.guild.id, cmd.name)
  if (!current.includes(role.id)) {
    return m.reply({ ephemeral: true, content: `<@&${role.id}> is not on the list for \`${cmd.name}\`.` })
  }

  const next = current.filter(id => id !== role.id)
  conn.cfg.access.set(m.guild.id, cmd.name, next)
  if (next.length) return m.reply(`<@&${role.id}> can no longer use \`${cmd.name}\`.`)
  return m.reply(`\`${cmd.name}\` has no role restrictions anymore, so it uses its default permission again.`)
}

handler.command = ['disallow']
handler.description = 'Remove a role from the list of roles that can use a command'
handler.tags = ['Settings']
handler.group = true
handler.permission = 'ManageGuild'
handler.options = [
  { name: 'role', description: 'Role to remove from the command', type: 'role', required: true },
  { name: 'command', description: 'Command name, for example ban', type: 'string', required: true }
]

export default handler

