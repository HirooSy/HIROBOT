import Connection from '../../lib/utils/connection.js'

let handler = async (m, { conn, platform }) => {
  if (platform == 'discord') {
    const list = [...conn.client.guilds.cache.values()]
      .sort((a, b) => b.memberCount - a.memberCount)
      .map((g, i) => `${i + 1}. **${g.name}** • ${g.memberCount} members • \`${g.id}\``)
    const body = list.join('\n')
    await m.reply({
      ephemeral: true,
      embeds: [conn.embed({ title: `Servers (${list.length})`, description: body.length > 4000 ? `${body.slice(0, 3990)}…` : body || 'None' })]
    })
    return
  }
    let txt = ''
    for (let [jid, chat] of Object.entries(Connection.store.chats).filter(([jid, chat]) => jid.endsWith('@g.us') && chat.isChats)) txt += `${await conn.getName(jid)}\n🪪${jid} [${chat?.metadata?.read_only ? 'Left' : 'Joined'}]\n\n`
    m.reply(`List Groups:
${txt}
`.trim())
}

handler.help = ['groups', 'grouplist']
handler.tags = ['info']
handler.command = ['servers', 'groups', 'grouplist']
handler.description = 'List the groups or servers the bot is in'
handler.ai = { risk: 'low', isTool: true, description: "Group list info" }
handler.platform = { whatsapp: true, discord: { permission: ['owner'] } }

export default handler
