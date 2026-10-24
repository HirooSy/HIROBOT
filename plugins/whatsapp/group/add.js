const {
	getBinaryNodeChild,
	getBinaryNodeChildren
} = (await import('baileys')
)


import util from'util'

let handler = async (m, { conn, text, participants, usedPrefix, command, isAdmin, isOwner }) => {
	if (!(isAdmin || isOwner)) {
		global.dfail('admin', m, conn)
		throw false
	}
	if (!text && m.quoted) text = m.quoted.sender.split('@')[0]
	else if (!text) throw `_Enter a number!_\nExample:\n\n${usedPrefix + command} ${global.settings.owner[0]?.[0] || ''}`
    let _participants = participants.map(user => user.id)
    let users = (await Promise.all(
        text.split(',')
            .map(v => v.replace(/[^0-9]/g, ''))
            .filter(v => v.length > 4 && v.length < 20 && !_participants.includes(v + '@s.whatsapp.net'))
            .map(async v => [
                v,
                await conn.onWhatsApp(v + '@s.whatsapp.net')
            ])
    )).filter(v => v[1][0]?.exists).map(v => v[0] + '@c.us')
    if (!users[0]) throw 'Number is not available on WhatsApp!';
    m.reply('_Processing..._')
    const response = await conn.query({
        tag: 'iq',
        attrs: {
            type: 'set',
            xmlns: 'w:g2',
            to: m.chat,
        },
        content: users.map(jid => ({
            tag: 'add',
            attrs: {},
            content: [{ tag: 'participant', attrs: { jid } }]
        }))
    })
    const pp = await conn.profilePictureUrl(m.chat, 'image').catch(_ => null)
    const jpegThumbnail = pp ? await (await fetch(pp)).buffer() : Buffer.alloc(0)
    const add = await getBinaryNodeChild(response, 'add')
    const participant = await getBinaryNodeChildren(response, 'add')
    let anu = participant[0].content.filter(v => v)
    if (anu[0].attrs.error == 408) conn.sendButton(m.chat, `Unable to add @${anu[0].attrs.jid.split('@')[0]}!\nIt looks like @${anu[0].attrs.jid.split('@')[0]} just left this group`, wm, 'https://telegra.ph/file/d5996f3ec87fabe48fdcb.jpg', [['Link', '.link']], m, { asLocation: true, mentions: conn.parseMention(`Unable to add @${anu[0].attrs.jid.split('@')[0]}!\nIt looks like @${anu[0].attrs.jid.split('@')[0]} just left this group`) }) // conn.sendButton(m.chat, `Unable to add @${anu[0].attrs.jid.split('@')[0]}!\nIt looks like @${anu[0].attrs.jid.split('@')[0]} just left this group :'v`, wm, 'link', usedPrefix + `link`, m)
    for (const user of participant[0].content.filter(item => item.attrs.error == 403)) {
    	const jid = user.attrs.jid
    	const content = await getBinaryNodeChild(user, 'add_request')
    	const invite_code = content.attrs.code
    	const invite_code_exp = content.attrs.expiration
    	const txt = `Inviting @${jid.split('@')[0]} using invite...`

    	conn.reply(m.chat, txt, m)// conn.sendButton(m.chat, txt, wm, 'menu', '.m', m)
    	await conn.sendGroupV4Invite(m.chat, jid, invite_code, invite_code_exp, await conn.getName(m.chat), 'Invitation to join my WhatsApp group', jpegThumbnail)
    }
    if (!anu[0].attrs.error) m.reply('Successfully added @' + anu[0].attrs.jid.split('@')[0] + ' \n'.trim())
}
handler.help = ['add'].map(v => v + ' @user')
handler.tags = ['group']
handler.command = /^(add)$/i

handler.admin = true
handler.group = true
handler.botAdmin = true
handler.fail = null
export default handler
