import os from 'os'
import { cpus, platform as osPlatform, totalmem, freemem } from 'os'
import { readFileSync } from 'fs'
import { performance } from 'perf_hooks'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function format(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1)
  const value = bytes / Math.pow(1000, i)
  const str = i === 0 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '')
  return `${str} ${units[i]}`
}

function clockString(ms) {
  const d = Math.floor(ms / 86400000)
  const h = Math.floor(ms / 3600000) % 24
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60

  const parts = []
  if (d > 0) parts.push(`${d.toString().padStart(2, 0)} ᴅ`)
  if (h > 0) parts.push(`${h.toString().padStart(2, 0)} ʜ`)
  if (m > 0) parts.push(`${m.toString().padStart(2, 0)} ᴍ`)
  parts.push(`${s.toString().padStart(2, 0)} s`)

  return parts.join(', ')
}

function cleanCpuModel(model) {
  return model.replace(/\(R\)|\(TM\)|CPU/g, '').replace(/\s+/g, ' ').trim()
}

function getCgroupMemory() {
  try {
    const limit = parseInt(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'))
    const usage = parseInt(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'))
    if (!isNaN(limit) && !isNaN(usage)) return { total: limit, used: usage }
  } catch (e) {}
  try {
    const limit = parseInt(readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'))
    const usage = parseInt(readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'))
    if (!isNaN(limit) && !isNaN(usage)) return { total: limit, used: usage }
  } catch (e) {}
  return null
}

async function getStorageInfo() {
  let used = null, total = null

  try {
    const { stdout } = await execAsync(`du -sb "${process.cwd()}" 2>/dev/null`)
    const val = parseInt(stdout.split(/\s+/)[0])
    if (!isNaN(val)) used = val
  } catch (e) {}

  if (process.env.SERVER_DISK && !isNaN(parseInt(process.env.SERVER_DISK))) {
    total = parseInt(process.env.SERVER_DISK) * 1024 * 1024
  }

  if (total === null) {
    try {
      const { stdout } = await execAsync(`df -B1 "${process.cwd()}" 2>/dev/null`)
      const data = stdout.trim().split('\n')[1].split(/\s+/)
      total = parseInt(data[1])
      if (used === null) used = parseInt(data[2])
    } catch (e) {}
  }

  if (used === null || total === null) return null
  return { used, total }
}

let handler = async (m, { conn, platform }) => {
  if (platform == 'discord') {
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
    return
  }
  const uptime = clockString(process.uptime() * 1000)
  const memUsage = process.memoryUsage()
  const cpuList = cpus()

  const cgroupMem = getCgroupMemory()
  const ramTotal = cgroupMem ? cgroupMem.total : totalmem()
  const ramUsed = cgroupMem ? cgroupMem.used : (totalmem() - freemem())

  const storageInfo = await getStorageInfo()
  const driveUsed = storageInfo ? format(storageInfo.used) : 'Not Detect'

  const timestamp = performance.now()
  await m.react('⚙️')
  const latensi = performance.now() - timestamp

  const row = (label, value) => `${label.padEnd(8)} : ${value}`

  const info = [
    row('Runtime', uptime),
    row('CPU', cleanCpuModel(cpuList[0].model)),
    row('Cores', `${cpuList.length}`),
    row('RAM', `${format(ramUsed)} / ${format(ramTotal)}`),
    row('Disk', driveUsed),
    row('System', `${osPlatform()} ${process.arch} (Node ${process.env.NODE_VERSION})`),
  ].join('\n')

  const mem = [
    row('RSS', format(memUsage.rss)),
    row('Heap', `${format(memUsage.heapUsed)} / ${format(memUsage.heapTotal)}`),
    row('External', format(memUsage.external)),
    row('Buffers', format(memUsage.arrayBuffers)),
  ].join('\n')

  await conn.reply(m.chat, `\`\`\`${latensi.toFixed(4)} ms
──────────────────
${info}
──────────────────
${mem}\`\`\``, m)
  m.react('✅')
}

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

handler.help = ['ping', 'speed']
handler.tags = ['info', 'tools']
handler.command = ['ping', 'speed']
handler.description = 'Check the bot latency and system status'
handler.ai = { risk: 'low', summarize: true, description: "Check speed response bot" }
handler.platform = { whatsapp: true, discord: true }

export default handler
