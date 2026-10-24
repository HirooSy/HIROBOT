let handler = async (m, {  }) => {
  try {
    const invite = await m.channel.createInvite({ maxAge: 86400, maxUses: 0, unique: false })
    await m.reply(`https://discord.gg/${invite.code}\nExpires in 24 hours.`)
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not create an invite here, check my permissions.' })
  }
}

handler.command = ['link', 'linkgroup', 'linkgrup', 'serverlink']
handler.description = 'Create an invite link for this server'
handler.tags = ['Server']
handler.permission = 'CreateInstantInvite'
handler.group = true

export default handler

