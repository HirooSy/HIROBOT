// ─── tools/system.js ─────────────────────────────────────────────────────────
// Kategori: system_time, shell_exec, run_python, system_info, restart_bot, install_package
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'system_time',
    description: 'Ambil tanggal dan waktu saat ini sesuai zona waktu sender (otomatis menyesuaikan negara nomor sender; default Asia/Jakarta kalau sender dari Indonesia atau tidak terdeteksi).',
    parameters: {},
    execute: async () => {
        const { execAsync } = await getMcp()

        const tz = ctx().timezone || 'Asia/Jakarta'
        const { date, time, weekday } = formatDateTimeInZone(tz)
        return `Day: ${weekday}\nDate: ${date}\nTime: ${time} ${shortTzLabel(tz)}`;
    }
},
{
    name: 'shell_exec',
    description: 'Jalankan perintah shell di server (ls, cat, grep, ps, npm, git, dll). Perintah dijalankan di level OS, jadi otomatis bisa akses seluruh filesystem server (bukan cuma folder project) — command dengan path absolut (mis. "ls /", "cat /etc/hosts") jalan normal tanpa perlu setting apapun.',
    parameters: {
        command: { type: 'string', description: 'Perintah shell yang akan dijalankan', required: true },
        cwd:     { type: 'string', description: 'Working directory (opsional, default root project bot). Boleh diisi path absolut (mis. "/", "/home") untuk pindah working directory ke manapun di server.', required: false }
    },
    execute: async ({ command, cwd }) => {
        const { execAsync } = await getMcp()

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: cwd ? path.resolve(ROOT, cwd) : ROOT,
                timeout: 30000
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
    description: 'Jalankan kode Python di server dan kembalikan outputnya. Cocok untuk: kalkulasi matematika, manipulasi data, script utilitas, analisa teks, dsb. Kode ditulis ke file sementara lalu dieksekusi dengan python3. Output (stdout + stderr) dikembalikan ke AI dan dikirim ke user sebagai codeblock. Kalau butuh library eksternal (pandas, numpy, dll) yang belum ada, install dulu pakai install_package atau shell_exec.',
    parameters: {
        code:    { type: 'string', description: 'Kode Python yang akan dijalankan', required: true },
        timeout: { type: 'number', description: 'Timeout eksekusi dalam detik (default: 15)', required: false }
    },
    execute: async ({ code, timeout = 15 }) => {
        const { execAsync } = await getMcp()

        const tmpDir = path.join(ROOT, 'data', 'tmp')
        fs.mkdirSync(tmpDir, { recursive: true })
        const tmpFile = path.join(tmpDir, `_ai_py_${Date.now()}.py`)
        try {
            fs.writeFileSync(tmpFile, code, 'utf-8')
            const { stdout, stderr } = await execAsync(`python3 "${tmpFile}"`, {
                cwd: ROOT,
                timeout: Math.min(Number(timeout) || 15, 60) * 1000
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
    description: 'Cek info server: RAM, uptime, OS, Node version.',
    parameters: {},
    execute: async () => {
        const { execAsync } = await getMcp()

        const { default: os } = await import('os')
        const up  = process.uptime()
        const mem = process.memoryUsage()
        return [
            `*${process.env.BOT_NAME} — System Info*`,
            `OS: ${os.type()} ${os.release()} (${os.arch()})`,
            `CPU: ${os.cpus()[0]?.model || 'Unknown'} × ${os.cpus().length} core`,
            `RAM Total: ${(os.totalmem() / 1073741824).toFixed(2)} GB`,
            `RAM Free: ${(os.freemem() / 1073741824).toFixed(2)} GB`,
            `RAM Bot: ${(mem.rss / 1048576).toFixed(1)} MB (RSS)`,
            `Uptime: ${Math.floor(up / 3600)}j ${Math.floor((up % 3600) / 60)}m ${Math.floor(up % 60)}d`,
            `Node.js: ${process.version}`,
            `CWD: ${ROOT}`,
        ].join('\n')
    }
},
{
    name: 'restart_bot',
    description: 'Restart bot. Berguna setelah install package baru atau edit file penting.',
    parameters: {},
    execute: async () => {
        const { execAsync } = await getMcp()

        if (!process.send) {
            return 'GAGAL restart: proses ini gak jalan lewat start.js (mis. dijalankan langsung "node main.js"), jadi gak ada channel IPC buat kirim sinyal reset ke process manager-nya.'
        }
        if (ctx().conn && ctx().currentJid) {
            await ctx().conn.sendMessage(ctx().currentJid, { text: `${process.env.BOT_NAME} restart sebentar ya~` }, { quoted: ctx().currentM })
        }
        if (process.env.DATABASE) await db.write().catch(e => console.error('[restart_bot] db.write gagal:', e.message))
        await new Promise(resolve => setTimeout(resolve, 2000))
        process.send('reset')
        return 'Bot sedang restart...'
    }
},
{
    name: 'install_package',
    description: 'Install npm package baru di bot.',
    parameters: {
        package_name: { type: 'string', description: 'Nama package npm. Contoh: "axios", "moment"', required: true }
    },
    execute: async ({ package_name }) => {
        const { execAsync } = await getMcp()

        if (ctx().conn && ctx().currentJid) {
            await ctx().conn.sendMessage(ctx().currentJid, { text: `Menginstall ${package_name}... tunggu sebentar` }, { quoted: ctx().currentM })
        }
        try {
            const { stdout } = await execAsync(`npm install ${package_name} --no-audit --no-fund`, { cwd: ROOT, timeout: 120000 })
            return `${package_name} installed.\n\n${stdout.slice(-500)}`
        } catch (e) {
            return `Install failed for ${package_name}: ${e.message.slice(0, 300)}`
        }
    }
}
]
