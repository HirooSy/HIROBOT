let handler = async (m, { args, usedPrefix }) => {
  const name = String(args.name || '').trim().slice(0, 100)
  if (!name) return m.reply({ ephemeral: true, content: 'Give the role a name.' })
  try {
    const role = await m.guild.roles.create({ name, reason: `Created by ${m.member?.user?.username || 'bot'}` })
    return m.reply(`Created <@&${role.id}>. Set its color with \`${usedPrefix}colorrole\`.`)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not create the role, check my Manage Roles permission.' })
  }
}

handler.command = ['createrole', 'newrole']
handler.description = 'Create a new role in this server'
handler.tags = ['Roles']
handler.group = true
handler.permission = 'ManageRoles'
handler.options = [
  { name: 'name', description: 'Name of the new role (up to 100 characters)', type: 'string', required: true }
]

export default handler

