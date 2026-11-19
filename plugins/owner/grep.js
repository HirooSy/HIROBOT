import cp from 'child_process'
import fs from 'fs'
import nodePath from 'path'
import { promisify } from 'util'
let exec = promisify(cp.exec).bind(cp)

const searchJs = (dir, keyword, hits) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'sessions') continue
        const full = nodePath.join(dir, entry.name)
        if (entry.isDirectory()) searchJs(full, keyword, hits)
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            const rel = './' + nodePath.relative(process.cwd(), full).split(nodePath.sep).join('/')
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                if (line.includes(keyword)) hits.push(`${rel}:${i + 1}:${line}`)
            })
        }
    }
    return hits
}

let handler = async (m, { conn, text }) => {
    if (!text) throw "Keyword?"

    let o
    try {
        o = process.platform === 'win32'
            ? { stdout: searchJs(process.cwd(), text, []).join('\n'), stderr: '' }
            : await exec(`grep -rn "${text}" --include="*.js" --exclude-dir="node_modules" --exclude-dir="sessions" ./`)
    } catch (e) {
        o = e
    }

    let { stdout, stderr } = o

    if (stderr && stderr.trim()) {
        return m.reply(`Error: ${stderr}`)
    }

    if (!stdout || !stdout.trim()) {
        return m.reply(`Not found: "${text}"`)
    }

    let lines = stdout.trim().split('\n')
    let results = []
    let number = 1

    for (let line of lines) {
        let match = line.match(/^(.+?):(\d+):(.*)$/)
        if (match) {
            let [, path, lineNum, code] = match
            code = code.trim()
            if (code.length > 150) code = code.substring(0, 150) + '...'

            results.push(`${number}. *${path}* (line ${lineNum})\n> ${code}`)
            number++
        }
    }

    let output = results.join('\n\n')

    m.reply(`🔍 *Search results: "${text}"* (${results.length} found)\n\n${output}`)
}

handler.help = ['grep'].map(v => v + " <keyword>")
handler.tags = ['owner']
handler.command = /^(grep)$/i
handler.ai = { risk: 'low', summarize: true, description: "search exact keywords using grep -r" }

handler.platform = { whatsapp: { permission: ['rowner'] }, discord: false }

export default handler
