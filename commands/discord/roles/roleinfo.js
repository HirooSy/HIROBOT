let handler = async (m, { args, conn }) => {
  const role = await conn.find.role(m.guild, args.role)
  if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
  const perms = conn.roles.perms(role)
  return m.reply({
    ephemeral: true,
    embeds: [conn.embed({
      title: role.name,
      fields: [
        { name: 'Mention', value: `<@&${role.id}>`, inline: true },
        { name: 'ID', value: role.id, inline: true },
        { name: 'Color', value: role.color ? role.hexColor : 'Default', inline: true },
        { name: 'Position', value: String(role.position), inline: true },
        { name: 'Shown separately', value: role.hoist ? 'Yes' : 'No', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Managed', value: role.managed ? 'Yes, by an integration' : 'No', inline: true },
        { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`, inline: true },
        { name: 'Key permissions', value: perms.length ? perms.map(conn.roles.label).join(', ') : 'None' }
      ]
    })]
  })
}

handler.command = ['roleinfo']
handler.description = 'Show details about a role'
handler.tags = ['Roles']
handler.group = true
handler.options = [
  { name: 'role', description: 'Role to inspect', type: 'role', required: true }
]

export default handler

