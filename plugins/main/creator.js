let handler = async(m, { conn }) => {

  const data = global.settings.owner.filter(([id, isCreator]) => id && isCreator)
  conn.sendContact(m.chat, data.map(([id, name]) => [id, name]), m)

}
handler.help = ['owner', 'creator']
handler.tags = ['info']
handler.command = /^(owner|creator)$/i
handler.ai = { risk: 'low', description: "Send owner contact" }

export default handler
