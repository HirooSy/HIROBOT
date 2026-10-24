let handler = async (m, {  }) => {
  try {
    await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: null })
    await m.reply('Channel unlocked.')
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not unlock this channel, check my permissions.' })
  }
}

handler.command = ['unlock', 'open']
handler.description = 'Allow everyone to send messages in this channel again'
handler.tags = ['Server']
handler.permission = 'ManageChannels'
handler.group = true

export default handler

