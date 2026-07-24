import { plugins } from '../../lib/plugins.js'
import cp, { exec as _exec } from 'child_process'
import { promisify } from 'util'
import didyoumean from 'didyoumean'

let exec = promisify(_exec).bind(cp)

let handler = async (m, { conn, isROwner, usedPrefix, command, text }) => {
    await m.react("🔍")
    if (!isROwner) return

    let ar = Object.keys(plugins)
    let ar1 = ar.map(v => v.replace(/^plugins\//, '').replace(/\.js$/, ''))

    const buildList = () => {
        let grouped = {}
        for (let name of ar1) {
            let parts = name.split('/')
            let category = parts.length > 1 ? parts[0] : 'general'
            let pluginName = parts[parts.length - 1]
            if (!grouped[category]) grouped[category] = []
            grouped[category].push(pluginName)
        }
        return Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, names]) =>
                `*[ ${cat.toUpperCase()} ]*\n${names.sort().map(v => '- ' + v).join('\n')}`
            ).join('\n\n')
    }

    if (!text) throw `uhm.. where the text?\n\nexample:\n${usedPrefix + command} tools/sticker\n\n───────────────\n${buildList()}`

    let didResult = didyoumean(text, ar1)
    let didText = didResult == null ? '' : `\n> • Did You Mean : [ ${didResult} ]`

    if (!ar1.includes(text)) return m.reply(`> *NOT FOUND!*${didText}\n───────────────\n${global.readmore}\n\n${buildList()}`)

    let o
    try {
        o = await exec('cat plugins/' + text + '.js')
    } catch (e) {
        o = e
    } finally {
        let { stdout, stderr } = o
        if (stdout?.trim()) m.reply(stdout)
        if (stderr?.trim()) m.reply(stderr)
    }
}

handler.dym = ['getplugin']
handler.help = ['getplugin'].map(v => v + ' <kategori/nama>')
handler.tags = ['owner']
handler.command = /^(getplugin|gp)$/i
handler.rowner = true

export default handler