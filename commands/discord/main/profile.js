let handler = async (m, { args, user, conn }) => {
  const tiers = global.settings.tier || {}
  const self = m.user

  if (args.user && args.user.id !== self.id) {
    const other = conn.account(args.user.id)
    if (!other) return m.reply({ ephemeral: true, content: `${args.user.username} has not used this bot yet.` })
    return m.reply({ embeds: [card(conn.embed, args.user, other.data, !!other.linked, tiers)] })
  }

  const linked = !!conn.account(self.id)?.linked
  await m.reply({ embeds: [card(conn.embed, self, user, linked, tiers)] })
}

function card(embed, target, data, linked, tiers) {
  const level = data.level ?? 0
  const tier = tiers[level]?.name || tiers[0]?.name || '-'
  return embed({
    title: data.name || target.globalName || target.username,
    thumbnail: { url: target.displayAvatarURL({ size: 256 }) },
    fields: [
      { name: 'Tier', value: tier, inline: true },
      { name: 'EXP', value: String(data.exp ?? 0), inline: true },
      { name: 'Limit', value: String(data.limit ?? 0), inline: true },
      { name: 'Gems', value: String(data.gems ?? 0), inline: true },
      { name: 'Premium', value: data.premium ? 'Yes' : 'No', inline: true },
      { name: 'WhatsApp', value: linked ? 'Connected' : 'Not connected', inline: true }
    ]
  })
}

handler.command = ['profile']
handler.description = 'Show your profile'
handler.tags = ['Info']
handler.options = [
  { name: 'user', description: 'Another user to look up', type: 'user' }
]

export default handler
