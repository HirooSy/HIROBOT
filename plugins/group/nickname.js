let handler = async (m, { args, isOwner, conn }) => {
  const target = await conn.find.member(m.guild, args.user)
  if (!target) return m.reply({ ephemeral: true, content: 'That user is not in this server.' })
  if (!isOwner) {
    const blocked = conn.roles.hierarchy(m.guild, m.member, target)
    if (blocked) return m.reply({ ephemeral: true, content: blocked })
  }
  if (!(await conn.mod.canManage(m.guild, target))) {
    return m.reply({ ephemeral: true, content: 'I cannot change that member nickname, check my role position.' })
  }
  const name = String(args.name || '').trim() || null
  try {
    await conn.mod.nick(m.guild, target.id, name, `Changed by ${m.member?.user?.username || 'bot'}`)
    await m.reply(name ? `Nickname of <@${target.id}> set to **${name}**.` : `Nickname of <@${target.id}> reset.`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not change that nickname, check my permissions.' })
  }
}

handler.command = ['nickname', 'nick']
handler.description = 'Change or reset a member nickname'
handler.tags = ['Moderation']
handler.group = true
handler.help = [
  { name: 'user', description: 'Member to rename', type: 'user', required: true },
  { name: 'name', description: 'New nickname, leave empty to reset', type: 'string' }
]

handler.platform = { whatsapp: false, discord: { permission: ['manageNicknames'] } }

export default handler

