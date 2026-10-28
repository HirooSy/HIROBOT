import { areJidsSameUser } from 'baileys'
let handler = async (m, { conn, args, platform }) => {
  if (platform == 'discord') {
    if (!m.isGroup) return m.reply({ ephemeral: true, content: 'This command can only be used in a server.' })
    try {
      const invite = await m.channel.createInvite({ maxAge: 86400, maxUses: 0, unique: false })
      await m.reply(`https://discord.gg/${invite.code}\nExpires in 24 hours.`)
    } catch {
      await m.reply({ ephemeral: true, content: 'I could not create an invite here, check my permissions.' })
    }
    return
  }
    let group = m.chat
    if (/^[0-9]{5,16}-?[0-9]+@g\.us$/.test(args[0])) group = args[0]
    if (!/^[0-9]{5,16}-?[0-9]+@g\.us$/.test(group)) throw 'Can only be opened in a group'
    let groupMetadata = await conn.groupMetadata(group)
    if (!groupMetadata) throw 'groupMetadata is undefined :\\'
    if (!('participants' in groupMetadata)) throw 'participants is not defined :('
    let me = groupMetadata.participants.find(user => areJidsSameUser(user.id, conn.user.id))
    if (!me) throw 'I am not in that group :('
    if (!me.admin) throw 'I am not an admin T_T'
    m.reply('https://chat.whatsapp.com/' + await conn.groupInviteCode(group))
}

handler.help = ['linkgroup']
handler.tags = ['group']
handler.command = ['link', 'linkgroup', 'linkgrup', 'serverlink']
handler.description = 'Get the invite link of this group or server'
handler.platform = { whatsapp: true, discord: { permission: ['createInvite'] } }

export default handler
