import fetch from 'node-fetch'
let handler = async(m, { conn }) => {
	
  const data = global.owner.filter(([id, isCreator]) => id && isCreator)
  conn.sendContact(m.chat, data.map(([id, name]) => [id, name]), m)
    
}
handler.help = handler.dym = ['owner', 'creator']
handler.tags = ['info']

handler.command = /^(owner|creator)$/i

export default handler