let handler = async (m, { args, conn }) => {
  const requested = Math.min(Math.max(Number(args.amount) || 0, 1), 100)
  const extra = m.message ? 1 : 0
  let deleted
  try {
    deleted = await conn.mod.purge(m.channel, requested + extra)
  } catch {
    return m.reply({ ephemeral: true, content: 'I could not delete messages here, check my permissions.' })
  }
  const count = Math.max(deleted - extra, 0)
  const sent = await m.reply({ ephemeral: true, content: `Deleted ${count} message(s). Messages older than 14 days cannot be bulk deleted.` })
  if (m.message) setTimeout(() => sent?.delete?.().catch(() => {}), 5000)
}

handler.command = ['purge', 'clear', 'prune']
handler.description = 'Delete recent messages in this channel'
handler.tags = ['Moderation']
handler.permission = 'ManageMessages'
handler.group = true
handler.options = [
  { name: 'amount', description: 'Number of messages to delete (1-100)', type: 'integer', required: true, min_value: 1, max_value: 100 }
]

export default handler

