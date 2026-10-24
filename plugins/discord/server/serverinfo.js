let handler = async (m, { conn }) => {
  const owner = await m.guild.fetchOwner().catch(() => null)
  const channels = m.guild.channels.cache
  const fields = [
    { name: 'ID', value: m.guild.id, inline: true },
    { name: 'Owner', value: owner ? `<@${owner.id}>` : '-', inline: true },
    { name: 'Members', value: String(m.guild.memberCount), inline: true },
    { name: 'Channels', value: String(channels.size), inline: true },
    { name: 'Roles', value: String(m.guild.roles.cache.size), inline: true },
    { name: 'Boost', value: `Tier ${m.guild.premiumTier} (${m.guild.premiumSubscriptionCount || 0})`, inline: true },
    { name: 'Created', value: `<t:${Math.floor(m.guild.createdTimestamp / 1000)}:R>`, inline: true }
  ]
  const icon = m.guild.iconURL({ size: 256 })
  await m.reply({ embeds: [conn.embed({ title: m.guild.name, description: m.guild.description || undefined, ...(icon ? { thumbnail: { url: icon } } : {}), fields })] })
}

handler.command = ['serverinfo', 'infogrup', 'groupinfo', 'infogroup', 'infogc']
handler.description = 'Show information about this server'
handler.tags = ['Server']
handler.group = true

export default handler

