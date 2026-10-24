const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

let handler = async (m, { args, conn }) => {
  const parts = String(args.question).split('|').map(part => part.trim()).filter(Boolean)
  const question = clip(parts[0] || '', 256)
  if (!question) return m.reply({ ephemeral: true, content: 'Write a question for the poll.' })
  const options = parts.slice(1)
  if (options.length === 1) return m.reply({ ephemeral: true, content: 'Add at least two options, or leave them out for a yes or no poll.' })
  if (options.length > NUMBERS.length) return m.reply({ ephemeral: true, content: `A poll can have at most ${NUMBERS.length} options.` })

  const emojis = options.length ? NUMBERS.slice(0, options.length) : ['👍', '👎']
  const lines = options.length
    ? options.map((option, index) => `${emojis[index]} ${clip(option, 200)}`)
    : ['👍 Yes', '👎 No']
  const sent = await m.reply({
    embeds: [conn.embed({
      title: question,
      description: lines.join('\n'),
      footer: { text: `Poll by ${m.user.globalName || m.user.username}` }
    })]
  })
  for (const emoji of emojis) await sent?.react?.(emoji).catch(() => {})
}

handler.command = ['poll']
handler.description = 'Start a poll, separate options with |'
handler.tags = ['Utility']
handler.group = true
handler.options = [
  { name: 'question', description: 'Question, then options separated by | (empty options = yes or no)', type: 'string', required: true }
]

export default handler

