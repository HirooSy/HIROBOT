let handler = async (m, { args, conn }) => {
  const id = conn.find.id(args.userid)
  if (!id) return m.reply({ ephemeral: true, content: 'Give me a user ID or a mention.' })
  try {
    await conn.mod.unban(m.guild, id, `Unbanned by ${m.member?.user?.username || 'bot'}`)
    await m.reply(`<@${id}> was unbanned.`)
  } catch {
    await m.reply({ ephemeral: true, content: 'That user is not banned, or I could not unban them.' })
  }
}

handler.command = ['unban']
handler.description = 'Unban a user by ID or mention'
handler.tags = ['Moderation']
handler.permission = 'BanMembers'
handler.group = true
handler.options = [
  { name: 'userid', description: 'User ID or mention', type: 'string', required: true }
]

export default handler

