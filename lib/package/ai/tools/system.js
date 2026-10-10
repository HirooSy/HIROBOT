import { ctx, execAsync } from '../mcp.js';
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'system_time',
    description: 'Get the current date and time in the sender\'s time zone (adjusts automatically to the country of the sender\'s number; defaults to Asia/Jakarta if the sender is from Indonesia or the country cannot be detected).',
    parameters: {},
    execute: async () => {
        const tz = ctx().timezone || 'Asia/Jakarta'
        const { date, time, weekday } = formatDateTimeInZone(tz)
        return `Day: ${weekday}\nDate: ${date}\nTime: ${time} ${shortTzLabel(tz)}`;
    }
},
{
    name: 'shell_exec',
    description: 'Run a shell command on the server (ls, cat, grep, ps, npm, git, etc). The command runs at the OS level, so it can automatically access the whole server filesystem (not just the project folder) — commands with an absolute path (e.g. "ls /", "cat /etc/hosts") work normally without any setup. Long-running commands are allowed: pass a larger timeout for builds, installs or other slow jobs.',
    parameters: {
        command: { type: 'string', description: 'The shell command to run', required: true },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to the bot project root). An absolute path (e.g. "/", "/home") may be given to move the working directory anywhere on the server.', required: false },
        timeout: { type: 'number', description: 'Execution timeout in seconds (default: 120, maximum: 900)', required: false }
    },
    execute: async ({ command, cwd, timeout = 120 }) => {
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: cwd ? path.resolve(ROOT, cwd) : ROOT,
                timeout: Math.min(Math.max(Number(timeout) || 120, 1), 900) * 1000,
                maxBuffer: 32 * 1024 * 1024
            })
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '')
            return out.trim().slice(0, 4000) || '(no output)'
        } catch (err) {
            return `Error: ${err.message.slice(0, 500)}`
        }
    }
},
{
    name: 'run_python',
    description: 'Run Python code on the server and return its output. Good for: math calculations, data manipulation, utility scripts, text analysis, etc. The code is written to a temporary file and then executed with python3. The output (stdout + stderr) is returned to the AI and sent to the user as a codeblock. IMPORTANT about HTTP requests: do NOT use "requests" (it is not built in and needs to be installed first) — use Python\'s built-in "urllib.request" for simple GET/POST, which is enough and always available without installing anything. Other external libraries (pandas, numpy, etc) may not exist either; only if you really need one and there is no built-in alternative, install it with install_package or shell_exec. Long-running scripts are allowed: pass a larger timeout.',
    parameters: {
        code: { type: 'string', description: 'The Python code to run', required: true },
        timeout: { type: 'number', description: 'Execution timeout in seconds (default: 60, maximum: 600)', required: false }
    },
    execute: async ({ code, timeout = 60 }) => {
        const tmpDir = path.join(ROOT, 'data', 'tmp')
        fs.mkdirSync(tmpDir, { recursive: true })
        const tmpFile = path.join(tmpDir, `_ai_py_${Date.now()}.py`)
        try {
            fs.writeFileSync(tmpFile, code, 'utf-8')
            const { stdout, stderr } = await execAsync(`python3 "${tmpFile}"`, {
                cwd: ROOT,
                timeout: Math.min(Math.max(Number(timeout) || 60, 1), 600) * 1000,
                maxBuffer: 32 * 1024 * 1024
            })
            const output = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n[stderr]\n') || '(no output)'
            return JSON.stringify({
                __type: 'codeblock',
                title: 'Python Output',
                language: 'python',
                code: `# Code:\n${code}\n\n# Output:\n${output}`,
                description: output.slice(0, 200)
            })
        } catch (err) {
            const errMsg = err.killed ? `Timeout (>${timeout}s)` : (err.stderr || err.message || String(err))
            return JSON.stringify({
                __type: 'codeblock',
                title: 'Python Error',
                language: 'python',
                code: `# Code:\n${code}\n\n# Error:\n${errMsg}`,
                description: `${errMsg.slice(0, 150)}`
            })
        } finally {
            try { fs.unlinkSync(tmpFile) } catch (_) {}
        }
    }
},
{
    name: 'system_info',
    description: 'Check server info: RAM, uptime, OS, Node version.',
    parameters: {},
    execute: async () => {
        const { default: os } = await import('os')
        const up = process.uptime()
        const mem = process.memoryUsage()
        return [
            `*${global.settings.botname} — System Info*`,
            `OS: ${os.type()} ${os.release()} (${os.arch()})`,
            `CPU: ${os.cpus()[0]?.model || 'Unknown'} × ${os.cpus().length} cores`,
            `RAM Total: ${(os.totalmem() / 1073741824).toFixed(2)} GB`,
            `RAM Free: ${(os.freemem() / 1073741824).toFixed(2)} GB`,
            `RAM Bot: ${(mem.rss / 1048576).toFixed(1)} MB (RSS)`,
            `Uptime: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m ${Math.floor(up % 60)}s`,
            `Node.js: ${process.version}`,
            `CWD: ${ROOT}`,
        ].join('\n')
    }
},
{
    name: 'restart_bot',
    description: 'Restart the bot. Useful after installing a new package or editing an important file.',
    parameters: {},
    execute: async () => {
        if (!process.send) {
            return 'FAILED to restart: this process was not started through start.js (e.g. it was run directly with "node main.js"), so there is no IPC channel to send a reset signal to its process manager.'
        }
        if (ctx().conn && ctx().currentJid) {
            await ctx().conn.sendMessage(ctx().currentJid, { text: `${global.settings.botname} is restarting for a moment~` }, { quoted: ctx().currentM })
        }
        if (process.env.DATABASE) await db.write().catch(e => console.error('[restart_bot] db.write gagal:', e.message))
        await new Promise(resolve => setTimeout(resolve, 2000))
        process.send('reset')
        return 'Bot is restarting...'
    }
},
{
    name: 'install_package',
    description: 'Install a new npm package in the bot.',
    parameters: {
        package_name: { type: 'string', description: 'The npm package name. Example: "axios", "moment"', required: true }
    },
    execute: async ({ package_name }) => {
        if (ctx().conn && ctx().currentJid) {
            await ctx().conn.sendMessage(ctx().currentJid, { text: `Installing ${package_name}... please wait a moment` }, { quoted: ctx().currentM })
        }
        try {
            const { stdout } = await execAsync(`npm install ${package_name} --no-audit --no-fund`, { cwd: ROOT, timeout: 600000, maxBuffer: 32 * 1024 * 1024 })
            return `${package_name} installed.\n\n${stdout.slice(-500)}`
        } catch (e) {
            return `Install failed for ${package_name}: ${e.message.slice(0, 300)}`
        }
    }
}
]