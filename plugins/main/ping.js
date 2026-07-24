import Connection from '../../lib/connection.js'
import { cpus as _cpus, totalmem, freemem, platform, hostname } from 'os'
import os from 'os'
import { performance } from 'perf_hooks'
import { sizeFormatter } from 'human-readable'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

let handler = async (m, { conn }) => {
    let _uptime = process.uptime() * 1000
    let uptime = clockString(_uptime)
    const chats = Object.entries(Connection.store.chats).filter(([id, data]) => id && data.isChats)
    const groupsIn = chats.filter(([id]) => id.endsWith('@g.us'))
    const used = process.memoryUsage()
  
    const cpus = _cpus().map(cpu => {
        cpu.total = Object.keys(cpu.times).reduce((last, type) => last + cpu.times[type], 0)
        return cpu
    })
    const cpu = cpus.reduce((last, cpu, _, { length }) => {
        last.speed += cpu.speed / length
        return last
    }, { speed: 0 })

    let driveTotal = 'Not Detect', driveUsed = 'Not Detect', drivePer = 'Not Detect'
    try {
        let { stdout } = await execAsync('df -h /')
        let lines = stdout.trim().split('\n')
        let data = lines[1].split(/\s+/)
        driveTotal = data[1]
        driveUsed = data[2]
        drivePer = data[4]
    } catch (e) {}
        
    let d = new Date(new Date + 3600000)
    let locale = 'id'
    let times = d.toLocaleTimeString(locale, { hour: 'numeric', minute: 'numeric', second: 'numeric' })
    let timestamp = performance.now()
    await m.react('⚙️')
    let latensi = performance.now() - timestamp
    
    await conn.reply(m.chat, `*\`T  I  M  E\`*
- *Runtime :* ${uptime}
- *Time-Server :* ${times}
${global.readmore}
*\`C  H  A  T  S\`*
- *${groupsIn.length}* Group Chats
- *${chats.length - groupsIn.length}* Personal Chats
- *${chats.length}* Total Chats

*\`S  E  R  V  E  R\`*
- *CPU :* ${cpu.speed.toFixed(2)} MHz
- *RAM :* ${format(totalmem() - freemem())} / ${format(totalmem())}
- *Disk :* ${driveUsed} / ${driveTotal} (${drivePer})
- *Platform :* ${platform()}
- *Server :* ${hostname()}

*\`N  O  D  E  J  S\`*
${Object.keys(used).map((key, _, arr) => `- ${key.padEnd(Math.max(...arr.map(v => v.length)), ' ')}: ${format(used[key])}`).join('\n')}`, { key: { remoteJid: '0@s.whatsapp.net' }, message: { newsletterAdminInviteMessage: { newsletterJid: '120363280758084443@newsletter', newsletterName: '.', caption: `${latensi.toFixed(4)} ms` }}})
    m.react('✅')
}
handler.help = ['ping', 'speed']
handler.tags = ['info', 'tools']
handler.command = /^(ping|speed)$/i
handler.ai = { risk: 'low', isTool: false, summarize: true, description: "Check speed response bot" }
              
export default handler

let format = sizeFormatter({
  std: 'JEDEC',
  decimalPlaces: 2,
  keepTrailingZeroes: false,
  render: (literal, symbol) => `${literal} ${symbol}B`,
})
function clockString(ms) {
  let d = isNaN(ms) ? '--' : Math.floor(ms / 86400000)
  let h = isNaN(ms) ? '--' : Math.floor(ms / 3600000) % 24
  let m = isNaN(ms) ? '--' : Math.floor(ms / 60000) % 60
  let s = isNaN(ms) ? '--' : Math.floor(ms / 1000) % 60
  return [d, ' ᴅ, ', h, ' ʜ, ', m, ' ᴍ, ', s, ' s'].map(v => v.toString().padStart(2, 0)).join('')
}
