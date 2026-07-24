let handler = async (m, { conn, usedPrefix: _p,command, text }) => {
let chat = db.data.chats[m.chat]
    if (/setwelcome/i.test(command)) {
    	if (!text) return m.reply(`
> Contoh Penggunaan: ${_p + command} <text & options>
> *Options :*
  - @user
  - @subject
  - @decription
  
> *Contoh Text :*
   Welcome To @subject, @user!`)
        m.reply('successfully applied as welcome')
        chat.sWelcome = text
        }
        
    if (/setbye/i.test(command)) {
       if (!text) return m.reply(`
> Contoh Penggunaan: ${_p + command} <text & options>
> *Options :*
  - @user
  - @subject
  - @decription
  
> *Contoh Text :*
   Bye @user!`)
         m.reply('successfully applied as bye')
         chat.sBye = text }
       
}
handler.dym = ['setbye', 'setwelcome']
handler.help = ['setbye', 'setwelcome'].map(v => v + ' <text>')
handler.tags = ['owner']
handler.command = /^set(welcome|bye)$/i
handler.group = true
handler.admin = true

export default handler