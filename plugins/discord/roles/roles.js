function listOf(list) {
  const text = list.map(role => `<@&${role.id}>`).join(' ')
  return text.length > 3900 ? `${text.slice(0, 3900)}…` : text
}

function sortedRoles(list, everyoneId) {
  return list.filter(role => role.id !== everyoneId).sort((a, b) => b.position - a.position)
}

let handler = async (m, { args, conn }) => {
  if (args.user) {
    const target = await conn.find.member(m.guild, args.user)
    if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
    const list = sortedRoles(target.roleIds.map(id => m.guild.roles.cache.get(id)).filter(Boolean), m.guild.id)
    return m.reply({
      embeds: [conn.embed({
        title: `Roles of ${conn.find.displayName(target)}`,
        description: list.length ? listOf(list) : 'No roles.',
        footer: { text: `${list.length} role(s)` }
      })]
    })
  }
  await conn.roles.fetch(m.guild)
  const list = sortedRoles([...m.guild.roles.cache.values()], m.guild.id)
  return m.reply({
    embeds: [conn.embed({
      title: `${m.guild.name} roles`,
      description: list.length ? listOf(list) : 'No roles.',
      footer: { text: `${list.length} role(s)` }
    })]
  })
}

handler.command = ['roles']
handler.description = 'List server roles, or the roles of a member'
handler.tags = ['Roles']
handler.group = true
handler.options = [
  { name: 'user', description: 'Member to show roles for (leave empty for all server roles)', type: 'user' }
]

export default handler
