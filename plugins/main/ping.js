import { cpus, platform, totalmem, freemem } from 'os'
import { readFileSync } from 'fs'
import { performance } from 'perf_hooks'
import { sizeFormatter } from 'human-readable'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const format = sizeFormatter({
  std: 'JEDEC',
  decimalPlaces: 2,
  keepTrailingZeroes: false,
  render: (literal, symbol) => `${literal} ${symbol}B`,
})

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

let handler = async (m, { conn }) => {
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
    row('System', `${platform()} ${process.arch} (Node ${process.env.NODE_VERSION})`),
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

handler.help = ['ping', 'speed']
handler.tags = ['info', 'tools']
handler.command = /^(ping|speed)$/i
handler.ai = { risk: 'low', summarize: true, description: "Check speed response bot" }

export default handler