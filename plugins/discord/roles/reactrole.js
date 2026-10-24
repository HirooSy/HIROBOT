let handler = async (m, { args, isOwner, conn }) => {
  let ref = conn.cfg.reactions.parseMessage(args.message, m.chat)
  let pairsText = args.pairs
  if (!ref && m.quoted?.id) {
    ref = { guildId: m.guild?.id ?? null, channelId: m.chat, messageId: m.quoted.id }
    pairsText = [args.message, args.pairs].filter(Boolean).join(' ')
  }
  if (!ref) return m.reply({ ephemeral: true, content: 'Give the message ID or link, or reply to the message.' })
  if (!m.guild || (ref.guildId && ref.guildId !== m.guild.id)) return m.reply({ ephemeral: true, content: 'That message is in another server.' })

  const resolved = await conn.cfg.reactions.resolve(m.guild, m.member, isOwner, pairsText)
  if (resolved.error) return m.reply({ ephemeral: true, content: resolved.error })

  try {
    await conn.client.rest.get(`/channels/${ref.channelId}/messages/${ref.messageId}`)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not find that message in this server.' })
  }

  const added = []
  for (const pair of resolved.pairs) {
    try {
      await conn.client.rest.put(`/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(pair.emoji.path)}/@me`)
    } catch {
      return m.reply({ ephemeral: true, content: `I could not add ${pair.emoji.display}. Check the emoji and my Add Reactions permission.` })
    }
    conn.cfg.reactions.add(m.guild.id, ref.messageId, ref.channelId, pair.emoji, pair.role.id)
    added.push(`${pair.emoji.display} → <@&${pair.role.id}>`)
  }
  return m.reply({ ephemeral: true, content: `Added ${added.length} reaction role(s) to that message:\n${added.join('\n')}` })
}

handler.command = ['reactrole']
handler.description = 'Add reaction roles to an existing message'
handler.tags = ['Roles']
handler.permission = 'ManageRoles'
handler.group = true
handler.options = [
  { name: 'message', description: 'Message ID or link (or reply to the message)', type: 'string', required: true },
  { name: 'pairs', description: 'Emoji and role pairs, like 🎮 @Gamer, 🎵 @Music', type: 'string', required: true }
]

export default handler
