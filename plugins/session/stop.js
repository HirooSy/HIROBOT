import { areJidsSameUser } from 'baileys'
import Connection from '../../lib/connection.js'

const handler = async (m, { conn }) => {
    // Memungkinkan owner untuk menghentikan sesi bahkan jika menggunakan akun main
    // Selama dia adalah owner (handler.owner = true sudah memastikan ini)
    
    let foundKey = null
    for (const [key, _conn] of Connection.conns.entries()) {
        if (areJidsSameUser(_conn.user?.id, conn.user?.id)) {
            foundKey = key
            break
        }
    }

    if (!foundKey) {
        // Jika tidak ketemu di conns aktif, mungkin ini memang main bot
        if (areJidsSameUser((await Connection.conn).user.id, conn.user.id)) {
            throw "❌ You cannot stop the bot main session directly via this command."
        }
        throw `⚠️ This session was not found in the list of active connections.`
    }

    await conn.reply(m.chat, `Session is being stopped...`, m)

    try {
        conn.ev.removeAllListeners()
        conn.ws.close()
    } catch (e) {
        console.error('[Multi Session] Error while disconnecting:', e)
    }

    Connection.conns.delete(foundKey)
}

handler.help    = ['disconnect']
handler.tags    = ['session']
handler.command = /^(disconnect)$/i
handler.owner   = true
handler.ai      = { risk: "blocked", description: "stop user being sub-bot" }

export default handler
