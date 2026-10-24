let handler = async (m, { args, isOwner, conn }) => {
  const target = await conn.find.member(m.guild, args.user)
  if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
  if (target.id === m.member?.id) return m.reply({ ephemeral: true, content: 'You cannot kick yourself.' })
  if (!isOwner) {
    const blocked = conn.roles.hierarchy(m.guild, m.member, target)
    if (blocked) return m.reply({ ephemeral: true, content: blocked })
  }
  if (!(await conn.mod.canManage(m.guild, target))) {
    return m.reply({ ephemeral: true, content: 'I cannot kick that member, check my permissions and role position.' })
  }
  const reason = args.reason ? String(args.reason) : null
  try {
    await conn.mod.kick(m.guild, target.id, reason || `Kicked by ${m.member?.user?.username || 'bot'}`)
    await m.reply(`<@${target.id}> was kicked.${reason ? ` Reason: ${reason}` : ''}`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not kick that member, check my permissions.' })
  }
}

handler.command = ['kick']
handler.description = 'Kick a member from the server'
handler.tags = ['Moderation']
handler.permission = 'KickMembers'
handler.group = true
handler.options = [
  { name: 'user', description: 'Member to kick', type: 'user', required: true },
  { name: 'reason', description: 'Reason for the kick', type: 'string' }
]

export default handler

