let handler = async (m, { args, isOwner, conn, text, usedPrefix, command, platform, groupMetadata }) => {
  if (platform !== 'discord') {
    const digits = String(text || '').replace(/\D/g, '')
    const jid = m.mentionedJid?.[0] || m.quoted?.sender || (digits ? digits + '@s.whatsapp.net' : '')
    if (!jid) throw `Tag the member, reply to their message, or give a number.\nExample: ${usedPrefix + command} @user`
    if (jid === m.sender) throw 'You cannot kick yourself.'
    if (jid === conn.decodeJid(conn.user.id)) throw 'I cannot kick myself.'
    if (jid === groupMetadata?.owner) throw 'I cannot kick the group owner.'
    await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
    return conn.reply(m.chat, `@${jid.split('@')[0]} was kicked.`, m, { mentions: [jid] })
  }

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
handler.group = true
handler.help = [
  { name: 'user', description: 'Member to kick', type: 'user', required: true },
  { name: 'reason', description: 'Reason for the kick', type: 'string' }
]

handler.platform = { whatsapp: { permission: ['admin', 'botAdmin'] }, discord: { permission: ['kickMembers'] } }

export default handler

