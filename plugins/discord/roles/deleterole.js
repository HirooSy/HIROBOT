let handler = async (m, { args, isOwner, conn }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const problem = await conn.roles.error(m.guild, m.member, role, isOwner)
  if (problem) return m.reply({ ephemeral: true, content: problem })

  const name = role.name
  try {
    await role.delete(`Deleted by ${m.member?.user?.username || 'bot'}`)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not delete that role, check my Manage Roles permission.' })
  }
  conn.cfg.forget(m.guild.id, role.id)
  return m.reply(`Deleted the role **${name}**.`)
}

handler.command = ['deleterole', 'delrole']
handler.description = 'Delete a role from this server'
handler.tags = ['Roles']
handler.group = true
handler.permission = 'ManageRoles'
handler.options = [
  { name: 'role', description: 'Role to delete', type: 'role', required: true }
]

export default handler

