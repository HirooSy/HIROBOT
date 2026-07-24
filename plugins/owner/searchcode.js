import cp from 'child_process'
import { promisify } from 'util'

let exec = promisify(cp.exec).bind(cp)

let handler = async (m, { conn, text }) => {
    if (!text) throw "Keyword?"
    
    let o
    try {
        o = await exec(`grep -rn "${text}" --include="*.js" --exclude-dir="node_modules" --exclude-dir="sessions" ./`)
    } catch (e) {
        o = e
    }
    
    let { stdout, stderr } = o
    
    if (stderr && stderr.trim()) {
        return m.reply(`❌ Error: ${stderr}`)
    }
    
    if (!stdout || !stdout.trim()) {
        return m.reply(`🔍 Not found: "${text}"`)
    }
    
    // Parse grep output
    let lines = stdout.trim().split('\n')
    let results = []
    let number = 1
    
    for (let line of lines) {
        // Format: ./path/file.js:123:content
        let match = line.match(/^(.+?):(\d+):(.*)$/)
        if (match) {
            let [, path, lineNum, code] = match
            // Trim and limit code length
            code = code.trim()
            if (code.length > 150) code = code.substring(0, 150) + '...'
            
            // Bold path using asterisks
            results.push(`${number}. *${path}* (line ${lineNum})\n> ${code}`)
            number++
        }
    }
    
    // Show all results without limit
    let output = results.join('\n\n')
    
    m.reply(`🔍 *Search results: "${text}"* (${results.length} found)\n\n${output}`)
}

handler.help = ['searchcode', 'scode'].map(v => v + " <keyword>")
handler.tags = ['owner']
handler.command = /^(s(earch)?code)$/i
handler.rowner = true
handler.ai = { risk: 'low', summarize: true, description: "search exact keywords using grep -r" }

export default handler