import fs from 'fs'
import Connection from '../../lib/connection.js'

const SESSION_BASE = 'sessions/jadibot'

const handler = async (m, { conn, usedPrefix }) => {
    // Kumpulkan semua JID yang punya folder session
    let sessionUsers = []
    if (fs.existsSync(SESSION_BASE)) {
        sessionUsers = fs.readdirSync(SESSION_BASE).filter(name =>
            fs.existsSync(`${SESSION_BASE}/${name}/creds.json`)
        )
    }

    if (sessionUsers.length === 0 && Connection.conns.size === 0) {
        return conn.reply(m.chat, `📭 No active or saved sessions found.`, m)
    }

    const votes = []

    for (const jid of sessionUsers) {
        const isOnline = Connection.conns.has(jid)
        const name = db.data?.users?.[jid]?.name
            || jid.split('@')[0]   // fallback ke nomor jika belum ada di db

        votes.push({
            name: `${isOnline ? '🟢' : '🔴'} ${name}`,
            voteCount: isOnline ? 1 : 0
        })
    }

    for (const [jid, subConn] of Connection.conns.entries()) {
        if (!sessionUsers.includes(jid)) {
            const name = db.data?.users?.[jid]?.name
                || subConn.user?.name
                || jid.split('@')[0]

            votes.push({
                name: `🟢 ${name} (${jid.split('@')[0]})`,
                voteCount: 1
            })
        }
    }

    votes.sort((a, b) => b.voteCount - a.voteCount)

    await conn.sendMessage(m.chat, {
        pollResult: {
            name: `Session List (${Connection.conns.size}/3 active)`,
            votes,
            pollType: 0
        }
    }, { quoted: m })
}

handler.help    = ['listsession']
handler.tags    = ['session']
handler.command = /^(listsession|sessions)$/i

export default handler