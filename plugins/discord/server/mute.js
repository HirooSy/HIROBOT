let handler = async (m, { args }) => {
  const target = await m.guild.members.fetch(args.user.id).catch(() => null)
  if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
  const minutes = Math.min(Math.max(Number(args.minutes) || 10, 1), 40320)
  try {
    await target.timeout(minutes * 60 * 1000, `Muted by ${m.member?.user?.tag || 'bot'}`)
    await m.reply(`<@${target.id}> muted for ${minutes} minute(s).`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not mute that member, check my permissions and role position.' })
  }
}

handler.command = ['mute']
handler.description = 'Time out a member'
handler.tags = ['Server']
handler.permission = 'ModerateMembers'
handler.group = true
handler.options = [
  { name: 'user', description: 'Member to mute', type: 'user', required: true },
  { name: 'minutes', description: 'Duration in minutes (default 10)', type: 'integer', min_value: 1, max_value: 40320 }
]

export default handler

