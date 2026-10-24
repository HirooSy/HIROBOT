let handler = async (m, { args, isOwner, conn }) => {
  const target = await conn.find.member(m.guild, args.user)
  if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const problem = await conn.roles.error(m.guild, m.member, role, isOwner)
  if (problem) return m.reply({ ephemeral: true, content: problem })
  if (!isOwner) {
    const blocked = conn.roles.hierarchy(m.guild, m.member, target)
    if (blocked) return m.reply({ ephemeral: true, content: blocked })
  }
  if (target.roleIds.includes(role.id)) return m.reply({ ephemeral: true, content: `<@${target.id}> already has <@&${role.id}>.` })
  try {
    await conn.memberRole.add(m.guild, target.id, role.id, `Added by ${m.member?.user?.username || 'bot'}`)
    await m.reply(`Added <@&${role.id}> to <@${target.id}>.`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not add that role, check my permissions and role position.' })
  }
}

handler.command = ['addrole', 'giverole']
handler.description = 'Give a role to a member'
handler.tags = ['Roles']
handler.permission = 'ManageRoles'
handler.group = true
handler.options = [
  { name: 'user', description: 'Member to give the role to', type: 'user', required: true },
  { name: 'role', description: 'Role to give', type: 'role', required: true }
]

export default handler

