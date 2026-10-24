let handler = async (m, {  }) => {
  try {
    await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: false })
    await m.reply('Channel locked.')
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not lock this channel, check my permissions.' })
  }
}

handler.command = ['lock', 'close']
handler.description = 'Stop everyone from sending messages in this channel'
handler.tags = ['Server']
handler.permission = 'ManageChannels'
handler.group = true

export default handler

