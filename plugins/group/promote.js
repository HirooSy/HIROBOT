let handler = async (m, { conn, text, usedPrefix }) => {
	text = no(text)

  if(isNaN(text)) {
		var number = text.split`@`[1]
  } else if(!isNaN(text)) {
		var number = text
  }

  if(!text && !m.quoted) return conn.reply(m.chat, `*❏ PROMOTE NUMBER*\n\n• \`\`\`\Tag user:\`\`\`\ *${usedPrefix}promote @Tag*\n• \`\`\`\Type Number:\`\`\`\ *${usedPrefix}promote 6289654360447*`, m)
    if(isNaN(number)) return conn.reply(m.chat, `*❏ PROMOTE NUMBER*\n\n• \`\`\`\Tag user:\`\`\`\ *${usedPrefix}promote @Tag*\n• \`\`\`\Type Number:\`\`\`\ *${usedPrefix}promote 6289654360447*`, m)
    if(number.length > 15) return conn.reply(m.chat, `*❏ PROMOTE NUMBER*\n\n• \`\`\`\Tag user:\`\`\`\ *${usedPrefix}promote @Tag*\n• \`\`\`\Type Number:\`\`\`\ *${usedPrefix}promote 6289654360447*`, m) 
		if(text) {
			var user = number + '@s.whatsapp.net'
		} else if(m.quoted.sender) {
			var user = m.quoted.sender
		} else if(m.mentionedJid) {
  		  var user = number + '@s.whatsapp.net'
			}  
		
	 await conn.groupParticipantsUpdate(m.chat, [user], 'promote')
 	conn.reply(m.chat, `Berhasil menjadi sebagai admin group @${number}`, null)
 
}
handler.help = ['promote <@user>']
handler.tags = ['group', 'admin']
handler.command = /^promote$/i
handler.group = true

handler.admin = true
handler.botAdmin = true

export default handler

function no(number){
    return number.replace(/\s/g,'').replace(/([@+-])/g,'')
  }