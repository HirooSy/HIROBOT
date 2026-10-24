let handler = async (m, { args }) => {
  const sides = Math.min(Math.max(Math.trunc(Number(args.sides)) || 6, 2), 1000)
  const result = 1 + Math.floor(Math.random() * sides)
  return m.reply(`🎲 d${sides}: **${result}**`)
}

handler.command = ['roll', 'dice']
handler.description = 'Roll a dice'
handler.tags = ['Utility']
handler.options = [
  { name: 'sides', description: 'Number of sides (2-1000, default 6)', type: 'integer', min_value: 2, max_value: 1000 }
]

export default handler

