import { ensureChatDefaults } from '../../../lib/utils/database.js'

const ON = /^(on|enable|true|1|yes)$/i
const OFF = /^(off|disable|false|0|no)$/i

let handler = async (m, { args }) => {
  const chat = ensureChatDefaults(m.channel.id)
  const state = String(args.state || '').trim()

  if (!state) {
    return m.reply({
      ephemeral: true,
      content: `AI auto chat is **${chat.aiChat ? 'on' : 'off'}** in this ${m.isGroup ? 'channel' : 'chat'}. Use \`aichat on\` or \`aichat off\`.`
    })
  }
  if (!ON.test(state) && !OFF.test(state)) {
    return m.reply({ ephemeral: true, content: 'Use `on` or `off`.' })
  }

  chat.aiChat = ON.test(state)
  await m.reply(
    chat.aiChat
      ? m.isGroup
        ? 'AI auto chat is on. Mention me or reply to my messages to talk without a prefix.'
        : 'AI auto chat is on. Just send me a message.'
      : 'AI auto chat is off.'
  )
}

handler.command = ['aichat']
handler.description = 'Turn AI auto chat on or off in this channel'
handler.tags = ['AI']
handler.permission = 'ManageGuild'
handler.options = [
  {
    name: 'state',
    description: 'on or off',
    type: 'string',
    choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }]
  }
]

export default handler
