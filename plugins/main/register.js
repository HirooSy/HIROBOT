let handler = async (m, { conn }) => {
    conn.sendButton(m.chat, {
    text: `Hi ${db.data.users[m.sender].name}, Sorry register only available on website`,
    nativeFlow: [ { text: 'Click Here', url: await getServerUrl() } ]
}, m)
}

handler.help = handler.command = ["daftar", "register"]
handler.tags = ['main']

export default handler
