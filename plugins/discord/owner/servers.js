let handler = async (m, { conn }) => {
  const list = [...conn.client.guilds.cache.values()]
    .sort((a, b) => b.memberCount - a.memberCount)
    .map((g, i) => `${i + 1}. **${g.name}** • ${g.memberCount} members • \`${g.id}\``)
  const body = list.join('\n')
  await m.reply({
    ephemeral: true,
    embeds: [conn.embed({ title: `Servers (${list.length})`, description: body.length > 4000 ? `${body.slice(0, 3990)}…` : body || 'None' })]
  })
}

handler.command = ['servers', 'groups', 'grouplist']
handler.description = 'List the servers the bot is in'
handler.tags = ['Owner']
handler.owner = true

export default handler
