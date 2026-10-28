let handler = async (m, { args, isOwner, conn, command }) => {
  if (command == 'ban') {
    const userId = String(args.user.id)
    if (userId === m.member?.id) return m.reply({ ephemeral: true, content: 'You cannot ban yourself.' })

    const target = await conn.find.member(m.guild, userId)
    if (target) {
      if (!isOwner) {
        const blocked = conn.roles.hierarchy(m.guild, m.member, target)
        if (blocked) return m.reply({ ephemeral: true, content: blocked })
      }
      if (!(await conn.mod.canManage(m.guild, target))) {
        return m.reply({ ephemeral: true, content: 'I cannot ban that member, check my permissions and role position.' })
      }
    }

    const days = Math.min(Math.max(Number(args.days) || 0, 0), 7)
    const reason = args.reason ? String(args.reason) : null
    try {
      await conn.mod.ban(m.guild, userId, {
        reason: reason || `Banned by ${m.member?.user?.username || 'bot'}`,
        deleteSeconds: days * 86400
      })
      await m.reply(`<@${userId}> was banned.${reason ? ` Reason: ${reason}` : ''}`)
    } catch {
      await m.reply({ ephemeral: true, content: 'I could not ban that user, check my permissions.' })
    }
  } else {
    const id = conn.find.id(args.userid)
    if (!id) return m.reply({ ephemeral: true, content: 'Give me a user ID or a mention.' })
    try {
      await conn.mod.unban(m.guild, id, `Unbanned by ${m.member?.user?.username || 'bot'}`)
      await m.reply(`<@${id}> was unbanned.`)
    } catch {
      await m.reply({ ephemeral: true, content: 'That user is not banned, or I could not unban them.' })
    }
  }
}

handler.command = ['ban', 'unban']
handler.description = {
  ban: 'Ban a user from the server',
  unban: 'Unban a user by ID or mention'
}
handler.tags = ['Moderation']
handler.help = [
  { command: 'ban', name: 'user', description: 'User to ban', type: 'user', required: true },
  { command: 'ban', name: 'days', description: 'Days of their messages to delete (0-7)', type: 'integer', min_value: 0, max_value: 7 },
  { command: 'ban', name: 'reason', description: 'Reason for the ban', type: 'string' },
  { command: 'unban', name: 'userid', description: 'User ID or mention', type: 'string', required: true }
]
handler.group = true
handler.platform = { whatsapp: false, discord: { permission: ['banMembers'] } }

export default handler
