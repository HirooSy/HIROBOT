import fs from 'fs'
import path from 'path'
import util from 'util'
const _fs = fs.promises

let handler = async (m, { text, usedPrefix, command, __dirname }) => {
	let name = ''
    if (!text) throw `
Penggunaan: ${usedPrefix}${command} <name file>
Contoh: ${usedPrefix}savefile main.js
        ${usedPrefix}saveplugin owner
        ${usedPrefix}savemedia img.png
`.trim()
    if (!m.quoted) throw `Balas/quote media/text yang ingin disimpan`
    
//• PLUGINS
    if (/v?p(lugin)?/i.test(command)) {
        name = `plugins/${text}.js`
    await fs.writeFileSync(name, m.quoted.text)
    m.reply(`tersimpan di ${name}`)
    }
//==========
//• FILE
    if (/f(ile)?/i.test(command)) {
      name = `${text}`
    await fs.writeFileSync(name, m.quoted.text)
    m.reply(`Saved ${name} to file!`)
}
        
     if (/m(edia)?/i.test(command)) {
     if (m.quoted.mediaMessage) {
            const media = await m.quoted.download()
            await _fs.writeFile(text, media)
            m.reply(`
Successfully saved media to *${text}*
`.trim())
        }}
        
}
handler.help = ['plugin', 'file', 'media'].map(v => `save${v} <name file>`)
handler.tags = ['owner']
handler.command = /^(save|s)((m(edia)?)|(v?p(lugin)?)|(f(ile)?))$/i

handler.rowner = true

export default handler