let handler = async (m, { args, conn }) => {
  const emoji = conn.cfg.reactions.parseEmoji(args.emoji)
  if (!emoji) return m.reply({ ephemeral: true, content: 'Give one emoji, for example 🎮 or a server emoji.' })

  let ref = args.message ? conn.cfg.reactions.parseMessage(args.message, m.chat) : null
  if (!ref && m.quoted?.id) ref = { guildId: m.guild?.id ?? null, channelId: m.chat, messageId: m.quoted.id }
  if (!ref) return m.reply({ ephemeral: true, content: 'Reply to the message, or give its ID or link.' })
  if (!m.guild || (ref.guildId && ref.guildId !== m.guild.id)) return m.reply({ ephemeral: true, content: 'That message is in another server.' })

  const entry = conn.cfg.reactions.list(m.guild.id)[String(ref.messageId)]
  if (!entry?.emojis?.[emoji.key]) {
    return m.reply({ ephemeral: true, content: `No reaction role uses ${emoji.display} on that message.` })
  }

  conn.cfg.reactions.remove(m.guild.id, ref.messageId, emoji.key)
  await conn.client.rest.delete(`/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(emoji.path)}/@me`).catch(() => {})
  return m.reply(`Removed the reaction role for ${emoji.display}.`)
}

handler.command = ['unreactrole']
handler.description = 'Stop giving a role for a reaction on a message'
handler.tags = ['Roles']
handler.permission = 'ManageRoles'
handler.group = true
handler.options = [
  { name: 'emoji', description: 'Emoji to remove', type: 'string', required: true },
  { name: 'message', description: 'Message ID or link (or reply to the message)', type: 'string' }
]

export default handler
