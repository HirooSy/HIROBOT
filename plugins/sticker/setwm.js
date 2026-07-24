let handler = async (m, { conn, text, usedPrefix: p_, command }) => {

   if (!text) throw `- *Example:*\n- ${p_ + command} \`Name\` | \`Author\`\n- ${p_ + command} ${process.env.BOT_NAME} | Owner\n\n> *Note:* You can skip name using [ .swm  | author ], also You can skip author using [ .swm name ], and You can use \`Space\``
      let user = db.data.users[m.sender]
      let [ name, ...auth ] = text.split(`|`)
      let author = (auth || []).join('|')
      
      user.stickerwm = [name.trim(), author.trim()]
      
   m.react("✅")
  
}
handler.help = handler.dym = ['setwm']
handler.tags = ['sticker']
handler.command = /^setwm$/i

handler.level = 2

export default handler
