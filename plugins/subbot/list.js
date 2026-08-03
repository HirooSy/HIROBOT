import Connection from '../../lib/connection.js'
import db from '../../lib/database.js'
import { listSavedSessionJids, getSubbotConfig } from './connect.js'

const handler = async (m, { conn }) => {
    const sessionJids = listSavedSessionJids()

    if (sessionJids.length === 0 && Connection.conns.size === 0) {
        return conn.reply(m.chat, `📭 No active or saved sessions found.`, m)
    }

    const lines = []

    for (const jid of sessionJids) {
        const isOnline = Connection.conns.has(jid)
        const name = db.data?.users?.[jid]?.name || jid.split('@')[0]
        lines.push(`${isOnline ? '🟢' : '🔴'} ${name}`)
    }

    for (const [jid, subConn] of Connection.conns.entries()) {
        if (sessionJids.includes(jid)) continue

        const name = db.data?.users?.[jid]?.name
            || subConn.user?.name
            || jid.split('@')[0]

        lines.push(`🟢 ${name} (${jid.split('@')[0]})`)
    }

    const { max } = getSubbotConfig()
    const text = `*Session List (${Connection.conns.size}/${max} active)*\n\n${lines.join('\n')}`

    await m.reply(text)
}

handler.help = ['listsubbot']
handler.tags    = ['subbot']
handler.command = /^(list(sub)?bot)$/i
handler.ai      = { risk: "low", description: "show active sub-bots" }

export default handler
