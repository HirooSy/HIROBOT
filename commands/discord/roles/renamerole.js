let handler = async (m, { args, isOwner, conn }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const problem = await conn.roles.error(m.guild, m.member, role, isOwner)
  if (problem) return m.reply({ ephemeral: true, content: problem })

  const name = String(args.name || '').trim().slice(0, 100)
  if (!name) return m.reply({ ephemeral: true, content: 'Give the role a new name.' })
  try {
    await role.edit({ name }, `Renamed by ${m.member?.user?.username || 'bot'}`)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not rename that role, check my Manage Roles permission.' })
  }
  return m.reply(`Renamed <@&${role.id}> to **${name}**.`)
}

handler.command = ['renamerole']
handler.description = 'Rename a role in this server'
handler.tags = ['Roles']
handler.group = true
handler.permission = 'ManageRoles'
handler.options = [
  { name: 'role', description: 'Role to rename', type: 'role', required: true },
  { name: 'name', description: 'New name (up to 100 characters)', type: 'string', required: true }
]

export default handler

