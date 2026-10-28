let handler = async (m, { user, conn }) => {
  const url = global.getServerUrl?.() || ''
  const ready = url && !url.includes('not-loaded.yet')
  const account = conn.account(m.sender)
  const linked = !!account?.linked

  if (linked) {
    const number = String(account.key || '').replace(/@.*$/, '')
    return m.reply({
      ephemeral: true,
      embeds: [conn.embed({
        title: 'Account connected',
        description: `This Discord account is connected to WhatsApp number \`${number.slice(0, 4)}${'•'.repeat(Math.max(0, number.length - 7))}${number.slice(-3)}\`.`
      })]
    })
  }

  await m.reply({
    ephemeral: true,
    embeds: [conn.embed({
      title: 'Connect your WhatsApp',
      description: [
        'Your progress is stored temporarily and will be merged into your WhatsApp account once you connect.',
        '',
        ready
          ? `1. Open ${url}\n2. Choose **Continue with Discord** and sign in\n3. Enter your WhatsApp number and the code sent to it`
          : 'The website is not available yet, try again in a moment.'
      ].join('\n'),
      fields: [
        { name: 'EXP', value: String(user.exp ?? 0), inline: true },
        { name: 'Limit', value: String(user.limit ?? 0), inline: true }
      ]
    })]
  })
}

handler.command = ['connect', 'register', 'daftar']
handler.description = 'Connect your Discord account with your WhatsApp account'
handler.tags = ['Info']

handler.platform = { whatsapp: false, discord: true }

export default handler
