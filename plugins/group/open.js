let handler = async (m, { conn, args, usedPrefix, command }) => {
    let isClose = {
        'open': 'not_announcement',
        'close': 'announcement',
    }[(args[0] || '')]
    if (isClose === undefined)
        throw `*Example :*
- ${usedPrefix + command} close
- ${usedPrefix + command} open
`.trim()
    await conn.groupSettingUpdate(m.chat, isClose)
}
handler.help = ['group <open/close>']
handler.tags = ['group']
handler.command = /^(group)$/i

handler.admin = true
handler.botAdmin = true

export default handler
