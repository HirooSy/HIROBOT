let handler = async (m, { args, conn }) => {
  const target = args.user || m.user
  const targetMember = m.guild ? await m.guild.members.fetch(target.id).catch(() => null) : null
  const stamp = date => (date ? `<t:${Math.floor(date.getTime() / 1000)}:R>` : '-')

  const fields = [
    { name: 'ID', value: target.id, inline: true },
    { name: 'Username', value: target.username, inline: true },
    { name: 'Bot', value: target.bot ? 'Yes' : 'No', inline: true },
    { name: 'Created', value: stamp(target.createdAt), inline: true }
  ]
  if (targetMember) {
    fields.push({ name: 'Joined', value: stamp(targetMember.joinedAt), inline: true })
    const roleMentions = targetMember.roles.cache.filter(r => r.id !== m.guild.id).map(r => `<@&${r.id}>`).slice(0, 15)
    if (roleMentions.length) fields.push({ name: 'Roles', value: roleMentions.join(' ') })
  }

  await m.reply({
    embeds: [conn.embed({
      title: target.globalName || target.username,
      thumbnail: { url: target.displayAvatarURL({ size: 256 }) },
      fields
    })]
  })
}

handler.command = ['userinfo']
handler.description = 'Show information about a user'
handler.tags = ['Info']
handler.options = [{ name: 'user', description: 'User to look up', type: 'user' }]

export default handler
