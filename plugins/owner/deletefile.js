import { tmpdir } from 'os'
import { plugins } from '../../lib/plugins.js'
import path, { join } from 'path'
import {
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  readFileSync,
  watch
} from 'fs'
let handler = async (m, { conn, usedPrefix, __dirname, args, text, command }) => {

if (command == "dfp") {
let ar = Object.keys(plugins)
    let ar1 = ar.map(v => v.replace('.js', '').replace('plugins/', ''))
    if (!text) throw `uhm.. where the text?\n\nexample:\n${usedPrefix + command} info`
    if (!ar1.includes(args[0])) return m.reply(`*🗃️ NOT FOUND!*\n==================================\n\n${ar1.map(v => ' ' + v).join`\n`}`)
const file = join(`${process.cwd()}/plugins/` + args[0] + '.js')
if (!existsSync(file)) return m.reply(`File "${args[0]}" tidak ditemukan.`)
unlinkSync(file)
conn.reply(m.chat, `Succes deleted "plugins/${args[0]}.js"`, m)
}
if (command == "df") {
	if (!args[0]) throw "Nama File?"
    
try {
const file = join(process.cwd() + "/" + args[0])
if (!existsSync(file)) return m.reply(`File "${args[0]}" tidak ditemukan.`)
unlinkSync(file)
await conn.reply(m.chat, `Succes deleted "${args[0]}"`, m)
} catch(e) {
    m.reply("Terjadi error: " + e.message)
  }
 }
}
handler.help = ['dfp', 'df']
handler.tags = ['owner']
handler.command = /^(dfp?)$/i

handler.rowner = true

export default handler
