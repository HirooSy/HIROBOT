let handler = async (m, { args }) => {
  const target = await m.guild.members.fetch(args.user.id).catch(() => null)
  if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
  try {
    await target.timeout(null)
    await m.reply(`<@${target.id}> unmuted.`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not unmute that member, check my permissions and role position.' })
  }
}

handler.command = ['unmute']
handler.description = 'Remove the timeout from a member'
handler.tags = ['Server']
handler.permission = 'ModerateMembers'
handler.group = true
handler.options = [{ name: 'user', description: 'Member to unmute', type: 'user', required: true }]

export default handler

