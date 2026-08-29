let handler = async(m, { conn }) => {

  const [id] = global.settings.owner[0] || []
  conn.sendContact(m.chat, [[id, "OWNER"]], m)

}
handler.help = ['owner', 'creator']
handler.tags = ['info']
handler.command = /^(owner|creator)$/i
handler.ai = { risk: 'low', description: "Send owner contact" }

export default handler
