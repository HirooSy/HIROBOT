import cp, { exec as _exec } from 'child_process'
import { promisify } from 'util'
let exec = promisify(_exec).bind(cp)
let handler = async (m, { conn, isOwner, command, text }) => {
  if (conn.user.jid != conn.user.jid || m.sender == conn.user.jid && (m.id).startsWith("3EB0")) return
  m.reply('Executing...')
  let o
  try {
    o = await exec(command.trimStart()  + ' ' + text.trimEnd())
  } catch (e) {
    o = e
  } finally {
    let { stdout, stderr } = o
    if (stdout.trim()) conn.sendMessage(m.chat, { text: stdout }, { quoted: m })
    if (stderr.trim()) conn.sendMessage(m.chat, { text: stderr }, { quoted: m })
  }
}
handler.help = ["$"]
handler.tags = ['advanced']
handler.customPrefix = /^[$] /
handler.command = new RegExp
handler.rowner = true
export default handler