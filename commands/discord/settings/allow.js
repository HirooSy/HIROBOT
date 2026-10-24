let handler = async (m, { args, conn, usedPrefix }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  if (role.id === m.guild.id) {
    return m.reply({ ephemeral: true, content: 'Pick a role other than @everyone. Commands with no roles are already open to everyone.' })
  }

  const query = conn.find.commandName(args.command)
  const cmd = conn.find.command(query)
  if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
  if (conn.cfg.access.locked.has(cmd.name)) {
    return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so its access cannot be changed.` })
  }

  const current = conn.cfg.access.roles(m.guild.id, cmd.name)
  if (current.includes(role.id)) return m.reply({ ephemeral: true, content: `<@&${role.id}> can already use \`${cmd.name}\`.` })

  conn.cfg.access.set(m.guild.id, cmd.name, [...current, role.id])
  return m.reply(`<@&${role.id}> can now use \`${cmd.name}\`. Only the roles on its list and server admins can use it. Check it with \`${usedPrefix}access ${cmd.name}\`.`)
}

handler.command = ['allow']
handler.description = 'Let a role use a command, which limits it to the roles you add'
handler.tags = ['Settings']
handler.group = true
handler.permission = 'ManageGuild'
handler.options = [
  { name: 'role', description: 'Role that can use the command', type: 'role', required: true },
  { name: 'command', description: 'Command name, for example ban or createrole', type: 'string', required: true }
]

export default handler

