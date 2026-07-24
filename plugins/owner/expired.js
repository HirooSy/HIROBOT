let handler  = async (m, { conn, command, args, usedPrefix, DevMode, isPrems }) => {
	
	// ------- REQUIREMENT ------
  let type = (args[0] || '').toLowerCase()
  let _type = (args[0] || '').toLowerCase()
  let who
    if (m.isGroup) who = args[2] ? args[2] : m.chat
    else who = args[2]
  var teks = `                *EXPIRED*
\`\`\`• SET :
${usedPrefix + command} set <amount>

• DELETE :
${usedPrefix + command} del

• CEK :
${usedPrefix + command} cek\`\`\` `

let jumlahHari = 86400000
let now = new Date() * 1
var ppgc = await conn.resize(await conn.profilePictureUrl(m.chat, 'image').catch(_ => './lib/src/avatar_contact.png'), 300, 300)

  
//------------ CASE ------------
  try {
    if (/(expired)/i.test(command)) {
      const count = args[1] && args[1].length > 0 ? Math.min(99999999, Math.max(parseInt(args[1]), 1)) : !args[1] || args.length < 3 ? 1 : Math.min(1, count)
        switch (type) {
case 'set':
    if (!args[1]) throw 'masukan jumlah hari'
       jumlahHari = 86400000 * args[1]
       now = new Date() * 1
    if (now < db.data.chats[who].expired) db.data.chats[who].expired = jumlahHari
    else db.data.chats[who].expired = now + jumlahHari
    conn.reply(m.chat, `
                   *SET EXPIRED*
*• Expired :* ${args[1]} Days
*• Uptime :* 
${msToDate(db.data.chats[who].expired - now)}`, m)
         break

case 'del':
if (new Date() * 1 < db.data.chats[who].expired) db.data.chats[who].expired = false
    else db.data.chats[who].expired = false
    conn.reply(m.chat, `                     *DELETE EXPIRED*\n \`\`\`The expiration time in this group has been deleted by the owner\`\`\` `, m)
    break
    
case 'cek':
      if (db.data.chats[who].expired < 1) throw `\`\`\`This group is not set to expired !\`\`\` `
          jumlahHari = 86400000 * args[0]
          now = new Date() * 1
          let countDay = (msDay(db.data.chats[who].expired - now) == 0 ?  11 : msDay(db.data.chats[who].expired - now) * 1000)
    
      conn.reply(m.chat, `                        *CHECK EXPIRED*
\`\`\`• Expired : 
${msToDate(db.data.chats[who].expired - now)}\`\`\` `,m)
break
                 
default:
         return await conn.reply(m.chat, teks ,m)
        }
        } else if (/(Aoaoa)/i.test(command)) {
               const count = args[2] && args[2].length > 0 ? Math.min(99999999, Math.max(parseInt(args[2]), 1)) : !args[2] || args.length < 4 ? 1 :Math.min(1, count)
               switch (_type) {
           case 'A':
               break
           case '':
               break
default:
          return false;
         }
        }
       } catch (err) {
                      m.reply("Error\n\n\n" + err.stack)
      }

}

handler.help = ['expired <type>']
handler.tags = ['owner']
handler.command = /^(expired)$/i
handler.group = true

export default handler


function msToDate(ms) {
    let temp = ms
    let days = Math.floor(ms / (24 * 60 * 60 * 1000));
    let daysms = ms % (24 * 60 * 60 * 1000);
    let hours = Math.floor((daysms) / (60 * 60 * 1000));
    let hoursms = ms % (60 * 60 * 1000);
    let minutes = Math.floor((hoursms) / (60 * 1000));
    let minutesms = ms % (60 * 1000);
    let sec = Math.floor((minutesms) / (1000));
    return days + "Days\n" + hours + "Hours\n" + minutes + "Minute";
    // +minutes+":"+sec;
}

function msDay(ms) {
    let temp = ms
    let days = Math.floor(ms / (24 * 60 * 60 * 1000));
    let daysms = ms % (24 * 60 * 60 * 1000);
    return days;
    // +minutes+":"+sec;
}