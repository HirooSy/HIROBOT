let handler = async (m, { args, conn }) => {
  const target = args.user || m.user
  const url = target.displayAvatarURL({ size: 1024 })
  await m.reply({
    embeds: [conn.embed({ title: target.globalName || target.username, image: { url }, url })]
  })
}

handler.command = ['avatar']
handler.description = 'Show the avatar of a user'
handler.tags = ['Info']
handler.help = [{ name: 'user', description: 'User to look up', type: 'user' }]

handler.platform = { whatsapp: false, discord: true }

export default handler
