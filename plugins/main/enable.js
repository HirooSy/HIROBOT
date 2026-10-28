import { ensureChatDefaults } from '../../lib/utils/database.js'

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

let handler = async (m, { conn, usedPrefix, command, args, isOwner, isAdmin, isROwner, platform }) => {
  if (platform == 'discord') {
    const feature = String(args.feature || '').trim().toLowerCase()
    const enabled = /true|enable|(turn)?on|1/i.test(command)

    if (feature === 'aichat') {
      const chat = ensureChatDefaults(m.channel.id)
      chat.aiChat = enabled
      return m.reply(
        chat.aiChat
          ? m.isGroup
            ? 'AI auto chat is on. Mention me or reply to my messages to talk without a prefix.'
            : 'AI auto chat is on. Just send me a message.'
          : 'AI auto chat is off.'
      )
    }

    if (feature === 'welcome') {
      if (!m.guild) return m.reply({ ephemeral: true, content: 'Welcome messages only work in a server.' })
      const current = conn.cfg.get(m.guild.id)?.welcome

      if (!enabled || String(args.channel || '').toLowerCase() === 'off') {
        if (!current) return m.reply({ ephemeral: true, content: 'Welcome messages are already off.' })
        conn.cfg.set(m.guild.id, { welcome: null })
        return m.reply('Welcome messages turned off.')
      }

      if (!args.channel) {
        if (!current?.channelId) {
          return m.reply({ ephemeral: true, content: 'Welcome messages are off. Use `enable welcome #channel [message]` to turn them on.' })
        }
        return m.reply({
          ephemeral: true,
          embeds: [conn.embed({
            title: 'Welcome messages',
            fields: [
              { name: 'Channel', value: `<#${current.channelId}>`, inline: true },
              { name: 'Message', value: clip(current.message || conn.cfg.welcome.default, 1000) }
            ]
          })]
        })
      }

      const target = await conn.find.channel(m.guild, args.channel)
      if (!conn.find.isText(target)) return m.reply({ ephemeral: true, content: 'Pick a text channel in this server.' })
      const text = args.message ? clip(String(args.message).trim(), 1000) : ''
      conn.cfg.set(m.guild.id, { welcome: { channelId: target.id, message: text || null } })
      return m.reply({
        ephemeral: true,
        embeds: [conn.embed({
          title: 'Welcome messages enabled',
          description: `New members will be greeted in <#${target.id}>.\nPlaceholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\``
        })]
      })
    }

    return m.reply({ ephemeral: true, content: 'Available features: `aichat`, `welcome`.' })
  }

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
const FEATURES = [{ name: 'aichat', value: 'aichat' }, { name: 'welcome', value: 'welcome' }]

handler.help = [
  ...['en', 'dis'].map(v => v + 'able <option>'),
  { command: 'enable', name: 'feature', description: 'Feature to turn on', type: 'string', required: true, choices: FEATURES },
  { command: 'enable', name: 'channel', description: 'Welcome channel (only for welcome)', type: 'channel', channel_types: [0, 5] },
  { command: 'enable', name: 'message', description: 'Welcome text, {user} {username} {server} {count}', type: 'string' },
  { command: 'disable', name: 'feature', description: 'Feature to turn off', type: 'string', required: true, choices: FEATURES }
]
handler.tags = ['group', 'owner']
handler.command = ['enable', 'true', 'on', 'turnon', '1', 'disable', 'false', 'off', 'turnoff', '0']
handler.description = {
  enable: 'Turn a feature on',
  disable: 'Turn a feature off'
}
handler.ai = { risk: 'low', summarize: true, description: "Enable/disable option" }

handler.platform = { whatsapp: true, discord: { permission: ['manageServer'] } }

export default handler
