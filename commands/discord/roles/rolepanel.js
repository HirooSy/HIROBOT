let handler = async (m, { args, isOwner, conn }) => {
  const resolved = await conn.cfg.reactions.resolve(m.guild, m.member, isOwner, args.pairs)
  if (resolved.error) return m.reply({ ephemeral: true, content: resolved.error })

  const lines = resolved.pairs.map(pair => `${pair.emoji.display}  →  <@&${pair.role.id}>`)
  const panel = await m.channel.send({
    embeds: [conn.embed({
      title: 'Choose your roles',
      description: `React to get a role, and remove your reaction to drop it.\n\n${lines.join('\n')}`
    })]
  })

  try {
    for (const pair of resolved.pairs) {
      await conn.client.rest.put(`/channels/${m.chat}/messages/${panel.id}/reactions/${encodeURIComponent(pair.emoji.path)}/@me`)
    }
  } catch {
    await panel.delete?.().catch(() => {})
    return m.reply({ ephemeral: true, content: 'I could not add the reactions. Check the emojis and my Add Reactions permission.' })
  }

  for (const pair of resolved.pairs) conn.cfg.reactions.add(m.guild.id, panel.id, m.chat, pair.emoji, pair.role.id)
  return m.reply({ ephemeral: true, content: `Role panel created with ${resolved.pairs.length} role(s).` })
}

handler.command = ['rolepanel']
handler.description = 'Post a message where members react to get roles'
handler.tags = ['Roles']
handler.permission = 'ManageRoles'
handler.group = true
handler.options = [
  { name: 'pairs', description: 'Emoji and role pairs, like 🎮 @Gamer, 🎵 @Music', type: 'string', required: true }
]

export default handler
