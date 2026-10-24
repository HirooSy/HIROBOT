let handler = async (m, { args, isOwner, conn }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const problem = await conn.roles.error(m.guild, m.member, role, isOwner)
  if (problem) return m.reply({ ephemeral: true, content: problem })

  const color = conn.roles.color(args.color)
  if (color === null) {
    return m.reply({ ephemeral: true, content: 'Use a hex color like `#ff8800`, or `off` to remove the color.' })
  }
  try {
    await role.edit({ color }, `Recolored by ${m.member?.user?.username || 'bot'}`)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not change that color, check my Manage Roles permission.' })
  }
  if (color === 0) return m.reply(`Removed the color of <@&${role.id}>.`)
  return m.reply(`Changed the color of <@&${role.id}> to \`#${color.toString(16).padStart(6, '0')}\`.`)
}

handler.command = ['colorrole']
handler.description = 'Change the color of a role, or remove it with "off"'
handler.tags = ['Roles']
handler.group = true
handler.permission = 'ManageRoles'
handler.options = [
  { name: 'role', description: 'Role to recolor', type: 'role', required: true },
  { name: 'color', description: 'Hex color like #ff8800, or "off"', type: 'string', required: true }
]

export default handler

