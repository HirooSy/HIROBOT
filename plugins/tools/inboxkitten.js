const formatLinks = links => links.reduce((acc, url) => `${acc}     ${url}\n`, '') || '     -\n'

const handler = async (m, { text, usedPrefix, command }) => {
  const name = (text || '').trim().toLowerCase().replace(/@inboxkitten\.com$/, '')
  if (!name) return m.reply(`Usage: ${usedPrefix}${command} <name>\nExample: ${usedPrefix}${command} hiro`)
  if (!/^[a-z0-9._-]{1,40}$/.test(name)) return m.reply('Invalid name. Use letters, numbers, dots, underscores or dashes (max 40 characters).')
  try {
    const { getDomains, getInbox, readMessage } = await global.scraper.get('inboxkitten')
    const [domain] = await getDomains()
    const address = `${name}@${domain}`
    const messages = await getInbox(address, 5)
    if (!messages.length) return m.reply(`- *Address:* ${address}\n\nInbox is empty.`)
    const details = await Promise.all(messages.map(msg => readMessage(msg.id).catch(() => ({}))))
    const list = messages.reduce((acc, msg, i) => `${acc}${i + 1}. ${msg.subject}\n   From: ${msg.from}\n   Time: ${msg.time || '-'}\n   OTP: ${details[i].otp || '-'}\n   Links:\n${formatLinks(details[i].links || [])}   Text: ${details[i].text || '-'}\n\n`, '')
    await m.reply(`- *Inbox (InboxKitten)*\n- *Address:* ${address}\n\n${list.trimEnd()}`)
  } catch (e) {
    await m.reply(`Failed to read inbox!\n${e.message}`)
  }
}
handler.help = ['inboxkitten <name>']
handler.description = 'Read the inbox of an InboxKitten temp email'
handler.tags = ['tools']
handler.command = /^(inboxkitten)$/i
handler.platform = { whatsapp: { permission: [] }, discord: { permission: [] } }
export default handler