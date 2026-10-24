const turnOff = (guild, reply, cfg) => {
  if (!cfg.get(guild.id)?.autoRole) return reply({ ephemeral: true, content: 'Auto role is already off.' })
  cfg.set(guild.id, { autoRole: null })
  return reply('Auto role turned off.')
}

let autorole = async (m, { args, isOwner, conn }) => {
  if (typeof args.role === 'string' && args.role.toLowerCase() === 'off') return turnOff(m.guild, m.reply, conn.cfg)

  if (!args.role) {
    const current = conn.cfg.get(m.guild.id)?.autoRole
    return m.reply({
      ephemeral: true,
      content: current ? `New members get <@&${current}>.` : 'Auto role is off. Use `autorole @role` to turn it on.'
    })
  }

  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const problem = await conn.roles.error(m.guild, m.member, role, isOwner)
  if (problem) return m.reply({ ephemeral: true, content: problem })
  conn.cfg.set(m.guild.id, { autoRole: role.id })
  return m.reply(`New members will get <@&${role.id}>.`)
}

autorole.command = ['autorole']
autorole.description = 'Set the role given to every new member'
autorole.tags = ['Welcome']
autorole.permission = 'ManageRoles'
autorole.group = true
autorole.options = [
  { name: 'role', description: 'Role to give new members (or "off")', type: 'role' }
]

let autoroleoff = async (m, { conn }) => turnOff(m.guild, m.reply, conn.cfg)

autoroleoff.command = ['autoroleoff']
autoroleoff.description = 'Turn off the auto role'
autoroleoff.tags = ['Welcome']
autoroleoff.permission = 'ManageRoles'
autoroleoff.group = true

export default [autorole, autoroleoff]
