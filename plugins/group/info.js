let handler = async (m, { conn, participants, groupMetadata, platform }) => {
  if (platform == 'discord') {
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
    return
  }
    const pp = await conn.profilePictureUrl(m.chat, 'image').catch(_ => null) || 'https://files.catbox.moe/ifx2y7.png'
    const { isBanned, welcome, detect, sWelcome, sBye, sPromote, sDemote, antiLink, delete: del } = db.data.chats[m.chat]
    const groupAdmins = participants.filter(p => p.admin)
    const listAdmin = groupAdmins.map((v, i) => `${i + 1}. @${v.id.split('@')[0]}`).join('\n')
    const owner = groupMetadata.owner || groupAdmins.find(p => p.admin === 'superadmin')?.id || m.chat.split`-`[0] + '@s.whatsapp.net'
    let text = `*「 Group Information 」*\n
*ID:*
${groupMetadata.id}
*Name:*
${groupMetadata.subject}
*Description:*
${groupMetadata.desc?.toString() || 'unknown'}
*Total Members:*
${participants.length} Members
*Group Owner:*
@${owner.split('@')[0]}
*Group Admins:*
${listAdmin}
*Group Settings:*
${isBanned ? '✅' : '❌'} Banned
${welcome ? '✅' : '❌'} Welcome
${detect ? '✅' : '❌'} Detect
${del ? '❌' : '✅'} Anti Delete
${antiLink ? '✅' : '❌'} Anti Link
*Message Settings:*
Welcome: ${sWelcome}
Bye: ${sBye}
Promote: ${sPromote}
Demote: ${sDemote}
`.trim()
    conn.sendFile(m.chat, pp, 'pp.jpg', text, m, false, { mentions: [...groupAdmins.map(v => v.id), owner] })
}

handler.help = ['infogrup']
handler.tags = ['group']
handler.command = ['serverinfo', 'groupinfo', 'grupinfo', 'infogroup', 'infogrup', 'infogc']
handler.description = 'Show information about this group or server'
handler.group = true
handler.platform = { whatsapp: true, discord: true }

export default handler
