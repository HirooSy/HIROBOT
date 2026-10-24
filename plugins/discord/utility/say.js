let handler = async (m, { args }) => {
  try {
    await m.channel.send({ content: String(args.text).slice(0, 2000), allowedMentions: { parse: [] } })
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not send a message here, check my permissions.' })
  }
  if (m.message) return m.message.delete().catch(() => {})
  return m.reply({ ephemeral: true, content: 'Sent.' })
}

handler.command = ['say']
handler.description = 'Make the bot say something in this channel'
handler.tags = ['Utility']
handler.permission = 'ManageMessages'
handler.group = true
handler.options = [
  { name: 'text', description: 'Message to send', type: 'string', required: true }
]

export default handler

