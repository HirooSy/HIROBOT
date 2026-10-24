let handler = async (m, { conn }) => {
  const lines = []
  for (const [messageId, entry] of Object.entries(conn.cfg.reactions.list(m.guild.id))) {
    for (const value of Object.values(entry.emojis || {})) {
      lines.push(`${value.display} → <@&${value.roleId}> • https://discord.com/channels/${m.guild.id}/${entry.channelId}/${messageId}`)
    }
  }
  if (!lines.length) return m.reply({ ephemeral: true, content: 'There are no reaction roles yet. Use `rolepanel` or `reactrole` to add some.' })
  return m.reply({ ephemeral: true, embeds: [conn.embed({ title: 'Reaction roles', description: lines.join('\n').slice(0, 3900) })] })
}

handler.command = ['reactroles']
handler.description = 'List the reaction roles in this server'
handler.tags = ['Roles']
handler.permission = 'ManageRoles'
handler.group = true

export default handler
