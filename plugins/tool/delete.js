let handler = async (m, { conn }) => {
  if (!m.isGroup) return dfail('group', m, conn)
  var key = {}
  try {
    key.remoteJid = m.quoted ? m.quoted.fakeObj.key.remoteJid : m.key.remoteJid
    key.fromMe = m.quoted ? m.quoted.fakeObj.key.fromMe : m.key.fromMe
    key.id = m.quoted ? m.quoted.fakeObj.key.id : m.key.id
    key.participant = m.quoted ? m.quoted.fakeObj.participant : m.key.participant
  } catch (e) { console.error(e) }
  conn.sendMessage(m.chat, { delete: key })
}
handler.help = ['delete']
handler.tags = ['tools']
handler.command = /^(delete)$/i
handler.risk = 'low'

export default handler
