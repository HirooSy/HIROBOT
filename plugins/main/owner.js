import { whatsappOwners } from '../../lib/utils/helper.js'

let handler = async(m, { conn }) => {

  const [id] = whatsappOwners()
  conn.sendContact(m.chat, [[id, "OWNER"]], m)

}
handler.help = ['owner', 'creator']
handler.tags = ['info']
handler.command = /^(owner|creator)$/i
handler.ai = { risk: 'low', description: "Send owner contact" }

handler.platform = { whatsapp: true, discord: false }

export default handler
