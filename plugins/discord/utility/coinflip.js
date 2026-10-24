let handler = async (m, {  }) => {
  return m.reply(`🪙 **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**`)
}

handler.command = ['coinflip', 'flip', 'coin']
handler.description = 'Flip a coin'
handler.tags = ['Utility']

export default handler

