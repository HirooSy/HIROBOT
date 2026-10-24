let handler = async (m, { conn, usedPrefix, command, args, isOwner, isAdmin, isROwner }) => {

  const options = [
    'welcome', 'silent', 'antidelete', 'antilink',
    'public', 'detect', 'restrict', 'autoread',
    'pconly', 'gconly', 'aiChat'
  ];

  let isEnable = /true|enable|(turn)?on|1/i.test(command)
  let chat = db.data.chats[m.chat]
  let user = db.data.users[m.sender]
  let bot = db.data.settings[conn.user.jid] || {}
  let type = (args[0] || '').toLowerCase()
  let isAll = false, isUser = false

  switch (type) {

         case 'welcome':
              if (!m.isGroup) {
              if (!isOwner) {
                  global.dfail('group', m, conn)
                  throw false }
             } else if (!isAdmin) {
                  global.dfail('admin', m, conn)
                  throw false;
             };
          chat.welcome = isEnable;
          break

        case 'detect':
            if (!m.isGroup) {
            if (!isOwner) {
                global.dfail('group', m, conn)
                throw false
            }} else if (!isAdmin) {
                global.dfail('admin', m, conn)
                throw false
              };
           chat.detect = isEnable
           break

        case 'antidelete':
            if (m.isGroup) {
            if (!(isAdmin || isOwner)) {
                global.dfail('admin', m, conn)
                throw false
             }};
         chat.delete = isEnable
         break

        case 'document':
            chat.useDocument = isEnable
            break

        case 'antinsfw':
            if (m.isGroup) {
        	if (!(isAdmin || isOwner)) {
                global.dfail('admin', m, conn)
                throw false
             }};
          chat.antinsfw = isEnable
          break

case "aichat":
          if (m.isGroup) {
        	if (!(isAdmin || isOwner)) {
                global.dfail('admin', m, conn)
                throw false
             }};
          chat.aiChat = isEnable
          break

        case 'public':
            isAll = true
            if (!isROwner) {
               global.dfail('rowner', m, conn)
               throw false
              };
        global.opts['self'] = !isEnable
        break

        case 'antilink':
            if (m.isGroup) {
            if (!(isAdmin || isOwner)) {
                global.dfail('admin', m, conn)
                throw false
            }};
         chat.antiLink = isEnable
         break

        case 'restrict':
            isAll = true
            if (!isOwner) {
                global.dfail('owner', m, conn)
                throw false
           };
         bot.restrict = isEnable
         break

         case 'silent':
         case 'nyimak':
         case 'mewing':
             isAll = true
             if (!isROwner) {
                 global.dfail('rowner', m, conn)
                 throw false
               };
           global.opts['nyimak'] = isEnable
           break

        case 'autoread':
            isAll = true
            if (!isROwner) {
                global.dfail('rowner', m, conn)
                throw false
             };
          global.opts['autoread'] = isEnable
          break

        case 'pconly':
        case 'privateonly':
            isAll = true
            if (!isROwner) {
                global.dfail('rowner', m, conn)
                throw false
              };
           global.opts['pconly'] = isEnable
           break

       case 'gconly':
       case 'grouponly':
           isAll = true
           if (!isROwner) {
               global.dfail('rowner', m, conn)
               throw false
             };
         global.opts['gconly'] = isEnable
         break

       case 'swonly':
       case 'statusonly':
           isAll = true
           if (!isROwner) {
               global.dfail('rowner', m, conn)
               throw false
             };
          global.opts['swonly'] = isEnable
          break

    default:
      if (!/[01]/.test(command)) {
        return conn.sendButton(m.chat, {
            text: '',
            ltoText: isEnable ? "Enable" : "Disable",
            ltoUrl: '\u0000',
            optionText: 'Select Options',
            optionTitle: 'Select Options',
            nativeFlow: options.map(opt => ({ text: `${opt}`, id: `${usedPrefix + command} ${opt}` }))
        }, m)
      }
      throw false
  }

  m.react(isEnable ? "🟢" : "🔴" )
}
handler.help = ['en', 'dis'].map(v => v + 'able <option>')
handler.tags = ['group', 'owner']
handler.command = /^((en|dis)able|(tru|fals)e|(turn)?o(n|ff)|[01])$/i
handler.ai = { risk: 'low', summarize: true, description: "Enable/disable option" }

export default handler
