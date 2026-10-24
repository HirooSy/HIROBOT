import os from 'os'

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ')
}

function size(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

let handler = async (m, { conn }) => {
  const sent = Date.now()
  await m.reply('Pinging...')
  const roundtrip = Date.now() - sent
  const gateway = Math.round(conn.client.ws.ping)
  const mem = process.memoryUsage()
  const cpus = os.cpus()

  await m.edit({
    content: '',
    embeds: [conn.embed({
      title: 'Pong!',
      fields: [
        { name: 'Roundtrip', value: `${roundtrip} ms`, inline: true },
        { name: 'Gateway', value: gateway >= 0 ? `${gateway} ms` : '-', inline: true },
        { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
        { name: 'CPU', value: `${(cpus[0]?.model || '-').replace(/\(R\)|\(TM\)|CPU/g, '').replace(/\s+/g, ' ').trim()} (${cpus.length} cores)` },
        { name: 'RAM', value: `${size(mem.rss)} / ${size(os.totalmem())}`, inline: true },
        { name: 'Heap', value: `${size(mem.heapUsed)} / ${size(mem.heapTotal)}`, inline: true }
      ]
    })]
  })
}

handler.command = ['ping', 'speed']
handler.description = 'Check the bot latency and system status'
handler.tags = ['Info']

export default handler
