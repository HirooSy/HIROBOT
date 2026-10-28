let handler = async (m, { command, conn, args, usedPrefix, platform }) => {
  const asked = String(platform === 'discord' ? args.mode ?? '' : args[0] ?? '').toLowerCase()
  const mode = command === 'group' ? asked : ['lock', 'close'].includes(command) ? 'close' : 'open'
  if (!['open', 'close'].includes(mode)) throw `*Example :*\n- ${usedPrefix + command} close\n- ${usedPrefix + command} open`

  if (platform !== 'discord') {
    await conn.groupSettingUpdate(m.chat, mode === 'close' ? 'announcement' : 'not_announcement')
    return m.reply(mode === 'close' ? 'Group closed, only admins can send messages.' : 'Group opened, everyone can send messages.')
  }

  try {
    await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: mode === 'close' ? false : null })
    await m.reply(mode === 'close' ? 'Channel locked.' : 'Channel unlocked.')
  } catch {
    await m.reply({ ephemeral: true, content: `I could not ${mode === 'close' ? 'lock' : 'unlock'} this channel, check my permissions.` })
  }
}

handler.command = ['lock', 'close', 'unlock', 'open', 'group']
handler.description = {
  lock: 'Stop everyone from sending messages in this channel or group',
  unlock: 'Allow everyone to send messages in this channel or group again',
  group: 'Open or close the group chat'
}
handler.tags = ['Server']
handler.group = true
handler.help = [
  'lock',
  'unlock',
  'group <open/close>',
  { command: 'group', name: 'mode', description: 'open or close', type: 'string', required: true, choices: [{ name: 'open', value: 'open' }, { name: 'close', value: 'close' }] }
]

handler.platform = { whatsapp: { permission: ['admin', 'botAdmin'] }, discord: { permission: ['manageChannels'] } }

export default handler
