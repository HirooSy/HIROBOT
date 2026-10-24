const PERMISSIONS = [1n, 16n, 64n, 1024n, 2048n, 16384n, 32768n, 65536n, 1n << 40n].reduce((a, b) => a | b, 0n)

let handler = async (m, { conn }) => {
  const id = conn.client.application?.id || conn.client.user.id
  const url = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`
  await m.reply({
    embeds: [conn.embed({ title: `Add ${global.settings.botname} to your server`, description: 'Pick a server you manage and approve the permissions.' })],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Add to server', url }] }]
  })
}

handler.command = ['invite', 'addbot']
handler.description = 'Get the link to add this bot to your server'
handler.tags = ['Info']

export default handler
