let handler = async (m, { args, conn }) => {
  const query = conn.find.commandName(args.command)
  const cmd = conn.find.command(query)
  if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
  if (conn.cfg.access.locked.has(cmd.name)) {
    return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so there is nothing to reset.` })
  }
  if (!conn.cfg.access.roles(m.guild.id, cmd.name).length) {
    return m.reply({ ephemeral: true, content: `\`${cmd.name}\` has no role restrictions.` })
  }
  conn.cfg.access.set(m.guild.id, cmd.name, [])
  return m.reply(`\`${cmd.name}\` is open again to its default permission.`)
}

handler.command = ['resetaccess']
handler.description = 'Clear the role restrictions of a command'
handler.tags = ['Settings']
handler.group = true
handler.permission = 'ManageGuild'
handler.options = [
  { name: 'command', description: 'Command to reset, for example ban', type: 'string', required: true }
]

export default handler

