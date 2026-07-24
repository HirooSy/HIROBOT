export async function all(m) {
    if (!m.isGroup)
        return
    let chats = db.data.chats[m.chat]
    if (!chats.expired)
        return !0
    if (+new Date() > chats.expired) {
        await this.reply(m.chat, 'Waktu Bot Digroup sudah habis, silahkan chat owner bot\n\n- Bot akan Keluar Otomatis')
        await this.groupLeave(m.chat)
        chats.expired = null
    }
}