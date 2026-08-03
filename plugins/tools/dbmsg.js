import { proto } from 'baileys'

let handler = async (m, { conn, command, usedPrefix, text }) => {

			if (/add(msg|vn|video|audio|img|sticker|gif)/i.test(command)) {
			    let M = proto.WebMessageInfo
			    let which = command.replace(/add/i, '')
			    if (!m.quoted) return;
			    if (!text) throw `Usage: ${usedPrefix + command} <teks>\nExample:\n${usedPrefix + command} tes`
			    let msgs = db.data.msgs
			    if (text in msgs) throw `'${text}' telah terdaftar!`
			    msgs[text] = M.fromObject(await m.getQuotedObj()).toJSON()
			await conn.react(m.chat, "✅", { remoteJid: m.key.remoteJid, id: m.key.id, fromMe: false, participant: m.key.participant})
			}

// ====== DELMSG =====
			if (/del(msg|vn|video|audio|img|sticker|gif)/i.test(command)) {
			if (!text) throw `Use *${usedPrefix}listmsg* to see the list`
			    let msgs = db.data.msgs
			    if (!(text in msgs)) throw `Data \`${text}\` not found.`
			    delete msgs[text]
			    conn.react(m.chat, "🗑️", { remoteJid: m.key.remoteJid, id: m.key.id, fromMe: false, participant: m.key.participant})
			}

// ===== GETMSG ======
			if (/get(msg|vn|video|audio|img|sticker|gif)/i.test(command)) {
			let which = command.replace(/get/i, '')
			    if (!text) throw `use *${usedPrefix}list${which}* to see the data list`
			    let msgs = db.data.msgs
			    if (!(text in msgs)) throw `'${text}' not listed in the message list`
			    let _m = conn.serializeM(JSON.parse(JSON.stringify(msgs[text]), (_, v) => {
			        if (
			            v !== null &&
			            typeof v === 'object' &&
			            'type' in v &&
			            v.type === 'Buffer' &&
			            'data' in v &&
			            Array.isArray(v.data)) {
			            return Buffer.from(v.data)
			        }
			        return v
			    }))
			    await _m.copyNForward(m.chat, true)
			}

//======= LISTMSG ========
			if (/list(msg|vn|video|audio|img|sticker|gif)/i.test(command)) {
			let msgs = db.data.msgs
			    let split = Object.entries(msgs).map(([nama, isi]) => { return { nama, ...isi} })
			    let fltr = split.map(v => `- ` + v.nama).join('\n')

			    conn.reply(m.chat,
`*List Message*\n${fltr}
─────────────────────
> Get :  \`\`\`.getmsg [text]\`\`\` `, m)
			}
}
handler.help = ['add', 'del', 'list', 'get'].map(v => v + 'msg <teks>')
handler.tags = ['database']
handler.command = /^(get|add|del|list)(vn|msg|video|audio|img|stic?ker|gif)$/

export default handler
