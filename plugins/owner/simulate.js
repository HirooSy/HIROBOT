let handler = async (m, { conn, usedPrefix, command, args: [event], text }) => {
    if (!event) return m.reply(`Example:
${usedPrefix + command} welcome @user
${usedPrefix + command} bye @user
${usedPrefix + command} promote @user
${usedPrefix + command} demote @user`)
    let mentions = text.replace(event, '').trimStart()
    let who = mentions ? conn.parseMention(mentions) : []
    let part = who.length ? who : [m.sender]
    let act = false
    m.reply(`Simulating *${event}...*`)
    switch (event.toLowerCase()) {
        case 'add':
        case 'invite':
        case 'welcome':
            act = 'add'
            break
        case 'bye':
        case 'kick':
        case 'leave':
        case 'remove':
            act = 'remove'
            break
        case 'promote':
            act = 'promote'
            break
        case 'demote':
            act = 'demote'
            break
        default:
            throw new Error(`Event "${event}" tidak dikenali`)
    }
    if (act) return conn.participantsUpdate({
        id: m.chat,
        participants: part,
        action: act
    })
}
handler.help = ['simulate <event> [@mention]']
handler.tags = ['owner']
handler.command = /^simulate$/i
handler.ai = { risk:'low', isTool: false, description: "dummy simulate group event" }

export default handler