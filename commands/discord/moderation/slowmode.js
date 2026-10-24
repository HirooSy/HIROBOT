function formatSeconds(seconds) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

let handler = async (m, { args, conn }) => {
  if (args.seconds === undefined || args.seconds === null) {
    const current = await conn.mod.slowmodeOf(m.channel)
    return m.reply(current ? `Slowmode is ${formatSeconds(current)}.` : 'Slowmode is off.')
  }
  const seconds = Math.min(Math.max(Math.trunc(Number(args.seconds)) || 0, 0), 21600)
  try {
    await conn.mod.slowmode(m.channel, seconds, `Set by ${m.member?.user?.username || 'bot'}`)
    await m.reply(seconds ? `Slowmode set to ${formatSeconds(seconds)}.` : 'Slowmode turned off.')
  } catch {
    await m.reply({ ephemeral: true, content: 'I could not change the slowmode here, check my permissions.' })
  }
}

handler.command = ['slowmode', 'slow']
handler.description = 'Set or check the slowmode of this channel'
handler.tags = ['Moderation']
handler.permission = args => (args.seconds === undefined || args.seconds === null ? null : 'ManageChannels')
handler.group = true
handler.options = [
  { name: 'seconds', description: 'Seconds between messages (0 turns it off)', type: 'integer', min_value: 0, max_value: 21600 }
]

export default handler

