import fs from 'fs'
import { join } from 'path'
import cp, { exec as _exec } from 'child_process'
import { promisify } from 'util'
import { plugins } from '../../lib/plugins.js'

const _fs = fs.promises
const exec = promisify(_exec).bind(cp)

const pluginNames = () =>
  Object.keys(plugins).map(v => v.replace(/^plugins\//, '').replace(/\.js$/, ''))

const listPluginsGrouped = () => {
  let grouped = {}
  for (let name of pluginNames()) {
    let [category, pluginName] = name.includes('/') ? name.split('/') : ['general', name]
    if (!grouped[category]) grouped[category] = []
    grouped[category].push(pluginName)
  }
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, names]) => `*[ ${cat.toUpperCase()} ]*\n${names.sort().map(v => '- ' + v).join('\n')}`)
    .join('\n\n')
}

// ---------- handler ----------
let handler = async (m, { conn, usedPrefix, command, args, text }) => {
  const cmd = command.toLowerCase()

  // ===== SAVE (savefile / saveplugin / savemedia) =====
  if (/^(save|s)(m(edia)?|v?p(lugin)?|f(ile)?)$/i.test(cmd)) {
    if (!text) throw `
Penggunaan: ${usedPrefix}${command} <name file>
Contoh: ${usedPrefix}savefile main.js
        ${usedPrefix}saveplugin owner
        ${usedPrefix}savemedia img.png
`.trim()
    if (!m.quoted) throw `Balas/quote media/text yang ingin disimpan`

    if (/v?p(lugin)?/i.test(cmd)) {
      let name = `plugins/${text}.js`
      await _fs.writeFile(name, m.quoted.text)
      return m.reply(`tersimpan di ${name}`)
    }
    if (/f(ile)?/i.test(cmd)) {
      await _fs.writeFile(text, m.quoted.text)
      return m.reply(`Saved ${text} to file!`)
    }
    if (/m(edia)?/i.test(cmd) && m.quoted.mediaMessage) {
      const media = await m.quoted.download()
      await _fs.writeFile(text, media)
      return m.reply(`Successfully saved media to *${text}*`)
    }
    return
  }

  // ===== DELETE (df / dfp) =====
  if (cmd === 'dfp') {
    if (!text) throw `uhm.. where the text?\n\nexample:\n${usedPrefix + command} info`
    if (!pluginNames().includes(args[0])) return m.reply(`*🗃️ NOT FOUND!*\n==================================\n\n${listPluginsGrouped()}`)
    const file = join(process.cwd(), 'plugins', `${args[0]}.js`)
    if (!fs.existsSync(file)) return m.reply(`File "${args[0]}" tidak ditemukan.`)
    fs.unlinkSync(file)
    return conn.reply(m.chat, `Succes deleted "plugins/${args[0]}.js"`, m)
  }

  if (cmd === 'df') {
    if (!args[0]) throw 'Nama File?'
    try {
      const file = join(process.cwd(), args[0])
      if (!fs.existsSync(file)) return m.reply(`File "${args[0]}" tidak ditemukan.`)
      fs.unlinkSync(file)
      return conn.reply(m.chat, `Succes deleted "${args[0]}"`, m)
    } catch (e) {
      return m.reply('Terjadi error: ' + e.message)
    }
  }

  // ===== GET (getplugin / gp) =====
  if (cmd === 'getplugin' || cmd === 'gp') {
    await m.react('🔍')
    const names = pluginNames()

    if (!text) throw `uhm.. where the text?\n\nexample:\n${usedPrefix + command} tools/sticker\n\n───────────────\n${listPluginsGrouped()}`

    if (!names.includes(text)) {
      return m.reply(`> *NOT FOUND!*\n───────────────\n${global.readmore}\n\n${listPluginsGrouped()}`)
    }

    try {
      let { stdout, stderr } = await exec(`cat plugins/${text}.js`)
      if (stdout?.trim()) m.reply(stdout)
      if (stderr?.trim()) m.reply(stderr)
    } catch (e) {
      m.reply(e.message || String(e))
    }
  }
}

handler.help = [
  ...['plugin', 'file', 'media'].map(v => `save${v} <name file>`),
  'dfp <plugin name>',
  'df <file name>',
  'getplugin <kategori/nama>'
]
handler.tags = ['owner']
handler.command = /^((save|s)(m(edia)?|v?p(lugin)?|f(ile)?)|dfp?|getplugin|gp)$/i
handler.rowner = true

export default handler
