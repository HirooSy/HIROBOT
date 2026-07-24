// ─── tools/plugin.js ─────────────────────────────────────────────────────────
// Kategori: list_plugins, run_plugin, check_plugin_risk, read_plugin_guide
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'
import db from '../../database.js'
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'list_plugins',
    description: 'SATU-SATUNYA sumber kebenaran soal command/plugin apa saja yang benar-benar ada di bot ini DAN memang diekspos ke AI (plugin tanpa handler.ai tidak akan muncul di sini sama sekali, karena dianggap sistem/internal-only) — sumber datanya sama persis dengan yang dipakai command ".menu" bawaan bot (plugin.help + plugin.tags), bukan tebakan/ingatan dari nama file atau bot lain. WAJIB dipanggil setiap kali user tanya soal command/fitur/plugin apa saja yang tersedia — JANGAN PERNAH jawab dari ingatan/tebakan karena bot ini TIDAK PUNYA command generik seperti get_random_x atau fitur AI image generation kecuali benar-benar muncul di hasil tool ini. Juga gunakan sebelum run_plugin untuk tahu nama command yang benar. Setiap command ditandai badge risiko (⛔ blocked, 🔴 high, 🟡 medium, 🟢 low, ⚪ none/belum dideklarasikan — lihat penjelasan lengkap di deskripsi run_plugin) supaya kamu langsung tahu mana yang boleh dijalankan bebas dan mana yang butuh owner/konfirmasi dulu. Kategori yang ada: main, group, sticker, ai, internet, adult, tools, downloader, owner, info.',
    parameters: {
        category: { type: 'string', description: 'Filter kategori/tag (opsional). Contoh: "main", "group", "downloader", "owner"', required: false }
    },
    execute: async ({ category } = {}) => {
        const { classifyPluginRisk, execPluginCommand, pluginRequirements, riskBadge } = await getMcp()

        try {
            const { plugins } = await import('../../plugins.js')


            const entries = Object.entries(plugins)
                // Plugin TANPA handler.ai dianggap sistem/internal-only dan gak pernah
                // diekspos ke AI sama sekali (gak usah di-load ke daftar ini).
                .filter(([, plugin]) => plugin && !plugin.disabled && plugin.help && plugin.ai && typeof plugin.ai === 'object')
                .map(([name, plugin]) => {
                    const helpList = Array.isArray(plugin.help) ? plugin.help : [plugin.help]
                    const tags = Array.isArray(plugin.tags) ? plugin.tags : (plugin.tags ? [plugin.tags] : [])
                    const cmds = helpList
                        .map(h => String(h).split(' ')[0])
                        .filter((c, i, arr) => c && arr.indexOf(c) === i)
                    const risk = classifyPluginRisk(name, plugin)
                    const reqs = pluginRequirements(plugin)
                    return { tags, cmds, reqs, risk: risk.level }
                })
                .filter(e => e.cmds.length)

            const filtered = category
                ? entries.filter(e => e.tags.some(t => String(t).toLowerCase() === category.toLowerCase()))
                : entries

            if (!filtered.length) return `No commands found${category ? ` for category "${category}"` : ''}.\nAvailable categories: main, group, sticker, ai, internet, adult, tools, downloader, owner, info`

            const grouped = {}
            for (const e of filtered) {
                const tag = e.tags[0] || 'lainnya'
                if (!grouped[tag]) grouped[tag] = []
                grouped[tag].push(e)
            }

            const totalCmds = filtered.reduce((n, e) => n + e.cmds.length, 0)
            let out = `*Command bot (${totalCmds}, sumber sama dengan .menu):*\n_Badge risiko: ⛔ blocked  🔴 high  🟡 medium  🟢 low_\n_Flag: Ⓛ limit  Ⓟ premium  Ⓖ group-only  Ⓓ DM-only  Ⓐ admin grup  Ⓑ bot-admin_\n\n`
            for (const [tag, list] of Object.entries(grouped)) {
                out += `*${tag}*\n`
                for (const e of list) {
                    const flags = [
                        e.reqs.limit ? 'Ⓛ' : '',
                        e.reqs.premium ? 'Ⓟ' : '',
                        e.reqs.group ? 'Ⓖ' : '',
                        e.reqs.private ? 'Ⓓ' : '',
                        e.reqs.admin ? 'Ⓐ' : '',
                        e.reqs.botAdmin ? 'Ⓑ' : '',
                    ].filter(Boolean).join('')
                    out += `  • ${riskBadge(e.risk)} ${e.cmds.join(', ')}${flags ? ` ${flags}` : ''}\n`
                }
                out += '\n'
            }
            return out.trim().slice(0, 4000)
        } catch (e) {
            return `Failed to read plugin list: ${e.message}`
        }
    }
},
{
    name: 'run_plugin',
    description: `Jalankan salah satu FITUR BOT yang sudah ada. Ini setara dengan user mengetik ".nama_fitur" di chat.

Plugin TANPA handler.ai sama sekali tidak akan pernah bisa dijalankan lewat tool ini (dianggap sistem/internal-only). Untuk plugin yang punya handler.ai, level risikonya DIPERCAYA LANGSUNG dari deklarasi handler.ai.risk + handler.ai.description milik plugin itu sendiri (cek dulu pakai check_plugin_risk kalau ragu, atau lihat badge-nya di list_plugins) — kecuali untuk command sistem paling sensitif (rowner-only, exec/session/secret) yang tetap ⛔ blocked keras apapun yang dideklarasikan plugin-nya. CATATAN: handler.ai.summarize menentukan APAKAH hasil plugin ditahan lalu kamu rangkai ulang jadi jawaban natural (true), atau plugin kirim balasannya sendiri langsung ke user dan kamu cukup diam (false/default) — lihat instruksi di dalam tool-result setelah run_plugin dipanggil, ikuti itu:
  ⛔ blocked → sistem/berbahaya/rowner-only (hard block, gak bisa diubah plugin), ATAU plugin memang tidak punya handler.ai. Tool ini akan MENOLAK sendiri, jangan dipaksa.
  🔴 high    → dideklarasikan plugin sebagai aksi owner-only/masif/destruktif. Hanya jalan kalau sender adalah owner — kalau bukan, tool ini otomatis menolak.
  🟡 medium  → dideklarasikan plugin sebagai perubahan state kecil/reversible. Tool ini akan MINTA KONFIRMASI dulu (return error "CONFIRM_REQUIRED") — begitu itu terjadi, TANYA ke user apakah yakin, dan HANYA kalau user sudah bilang setuju secara eksplisit, panggil ulang run_plugin dengan confirmed: true.
  🟢 low     → dideklarasikan plugin sebagai aman & idempotent (sticker, ping, downloader, dst) — contoh: "sticker"/"s"/"stiker" HANYA mengonversi gambar/video yang di-reply/attach jadi stiker, "tiktok"/"ig" HANYA download media dari URL publik. Langsung jalankan tanpa ragu.
  ⚪ none    → plugin punya handler.ai tapi BELUM mendeklarasikan risk sama sekali. JANGAN dianggap otomatis aman — tool ini akan MINTA KONFIRMASI dulu juga (sama seperti medium) sampai plugin-nya benar-benar dikasih handler.ai.risk oleh developer.

Selain risiko, ada syarat konteks terpisah dari flag lain plugin (handler.group, handler.private, handler.premium, handler.admin, handler.botAdmin) yang JUGA otomatis dicek dan bisa bikin tool ini menolak walau risikonya rendah: command grup-only ditolak kalau dipanggil dari DM (dan sebaliknya untuk DM-only), command premium-only ditolak kalau sender bukan premium/owner, command admin-only ditolak kalau sender bukan admin grup ini, command yang butuh bot jadi admin ditolak kalau bot belum admin di grup itu.

Command "menu" sudah dikonfirmasi 🟢 aman untuk SEMUA user — langsung jalankan tanpa ditanya-tanya dulu, sesuai rule MENU di system prompt. Command sejenis yang belum terverifikasi (misal "help", "allmenu", "list") bisa saja menampilkan command owner-only ke user biasa tergantung implementasi plugin-nya, jadi tool ini menahan command-command itu untuk non-owner secara khusus.`,
    parameters: {
        command:   { type: 'string', description: 'Nama command/plugin PERSIS seperti terdaftar (cek list_plugins/check_plugin_risk kalau ragu), tanpa prefix, dan JANGAN diterjemahkan dari maksud natural language user. Contoh: user minta "ping" → command: "ping". PENTING untuk plugin yang formatnya "nama_plugin <argumen>" (lihat handler.help di list_plugins, mis. "simulate <event> [@mention]"): command TETAP nama plugin-nya ("simulate"), argumen setelahnya ("bye", "promote", dst) masuk ke parameter args, BUKAN dijadikan command sendiri. Contoh salah: user bilang "coba simulate bye" lalu dipanggil command:"bye" — ini SALAH karena "bye" bukan nama plugin, itu argumen event untuk plugin "simulate". Contoh benar: command:"simulate", args:"bye".', required: true },
        args:      { type: 'string', description: 'Argumen tambahan untuk command (opsional)', required: false },
        confirmed: { type: 'boolean', description: 'Set true HANYA setelah user secara eksplisit menyetujui menjalankan command risiko 🟡 medium yang sebelumnya minta konfirmasi (CONFIRM_REQUIRED). Jangan pernah set true duluan tanpa persetujuan user.', required: false }
    },
    execute: async ({ command, args = '', confirmed = false }) => {
        const { classifyPluginRisk, execPluginCommand, pluginRequirements, riskBadge } = await getMcp()


        const MENU_LIKE_UNVERIFIED = ['help', 'allmenu', 'list']
        const normalizedCmd = command.trim().toLowerCase()
        if (MENU_LIKE_UNVERIFIED.includes(normalizedCmd) && !ctx().isOwner) {
            // Sebelum menolak, cek dulu apakah command ini sebenarnya resolve ke
            // plugin YANG SAMA dengan "menu" (mis. menu.js declare
            // handler.help = handler.dym = ['menu', 'help']). Kalau iya, ini
            // bukan plugin "help" terpisah yang belum terverifikasi -- ini
            // literally menu.js, yang sudah eksplisit di-whitelist aman.
            let isSameAsMenu = false
            try {
                const { plugins } = await import('../../plugins.js')
                const resolve = (cmdStr) => {
                    for (const [name, p] of Object.entries(plugins || {})) {
                        if (!p || typeof p !== 'function' || !p.command) continue
                        const c = p.command
                        const match = c instanceof RegExp ? c.test(cmdStr)
                            : Array.isArray(c) ? c.some(x => x === cmdStr || (x instanceof RegExp && x.test(cmdStr)))
                            : c === cmdStr
                        if (match) return name
                    }
                    return null
                }
                const menuTarget = resolve('menu')
                const thisTarget = resolve(normalizedCmd)
                isSameAsMenu = !!menuTarget && menuTarget === thisTarget
            } catch (_) { /* kalau gagal resolve, fallback ke behavior lama (tetap tolak) */ }

            if (!isSameAsMenu) {
                return `Command "${command}" tidak dijalankan otomatis lewat AI untuk non-owner — plugin ini berpotensi menampilkan daftar command owner. Jelaskan fitur bot pakai kata-katamu sendiri saja ke user, atau minta user ketik ".${command}" langsung.`
            }
        }
        try {
            // Cek dulu declared handler.ai.summarize plugin SEBELUM eksekusi --
            // ini flag YANG menentukan capture atau tidak. Kalau plugin gak
            // declare summarize sama sekali, DEFAULT-nya false (aman: plugin
            // lama gak berubah perilaku, tetap kirim langsung apa adanya
            // kayak sebelum fitur ini ada).
            const { plugins: pluginsPreCheck } = await import('../../plugins.js')
            let preCheckPlugin = null
            for (const [, p] of Object.entries(pluginsPreCheck || {})) {
                if (!p || typeof p !== 'function' || !p.command) continue
                const cmd = p.command
                const isMatch = cmd instanceof RegExp ? cmd.test(command)
                    : Array.isArray(cmd) ? cmd.some(c => c === command || (c instanceof RegExp && c.test(command)))
                    : cmd === command
                if (isMatch) { preCheckPlugin = p; break }
            }
            const shouldSummarize = preCheckPlugin?.ai?.summarize === true

            const { pluginName, captured } = await execPluginCommand(command, args, { confirmed, captureOutput: shouldSummarize })
            const { plugins } = await import('../../plugins.js')
            const risk = classifyPluginRisk(pluginName, plugins[pluginName])

            if (!shouldSummarize) {
                // Plugin gak minta di-summarize -- behavior lama: plugin sudah
                // kirim pesannya sendiri langsung ke user, AI cukup dikasih
                // tahu ringkas bahwa command-nya selesai (jangan ngarang detail).
                return `Command ".${command}${args ? ' ' + args : ''}" selesai dijalankan (risiko: ${riskBadge(risk.level)} ${risk.level}). Plugin sudah mengirim balasannya sendiri langsung ke user -- JANGAN tulis ulang/tambahkan balasan lain soal ini, cukup lanjut ke hal lain kalau ada, atau diam kalau tidak ada lagi yang perlu disampaikan.`
            }

            // Pisahkan captured messages: teks digabung jadi ringkasan buat
            // AI rangkai sendiri kalimatnya; media (image/video/document/dst)
            // TETAP dikirim beneran ke user apa adanya (AI gak bisa
            // "menceritakan ulang" gambar jadi teks), pakai conn asli
            // (bukan versi ke-wrap tadi, itu sudah di-restore).
            const conn = ctx().conn

            // Sebagian plugin nyelipin info tambahan (mis. latency ms) lewat
            // trik "fake quoted message" di opts (opts.quoted / opts itu
            // sendiri berisi { key, message: { xMessage: { caption/text } } }
            // dst) -- bukan di content utama. Gali rekursif cari field
            // text/caption/contextInfo di dalam objek itu, bukan cuma
            // content.text/caption biasa.
            function digForText(obj, depth = 0) {
                if (!obj || typeof obj !== 'object' || depth > 4) return []
                let out = []
                for (const [key, val] of Object.entries(obj)) {
                    if (typeof val === 'string' && val.trim() && /text|caption/i.test(key)) {
                        out.push(val)
                    } else if (val && typeof val === 'object') {
                        out = out.concat(digForText(val, depth + 1))
                    }
                }
                return out
            }

            const textParts = []
            for (const msg of captured) {
                const c = msg.content || {}
                if (typeof c.text === 'string') {
                    textParts.push(c.text)
                } else if (typeof c.conversation === 'string') {
                    textParts.push(c.conversation)
                } else if (c.caption) {
                    textParts.push(c.caption)
                }
                // Gali opts (mis. opts.quoted atau struktur message tersisip
                // lainnya) buat nangkep info tambahan spt latency ms yg
                // diselipkan via fake-quoted-message trick.
                if (msg.opts) {
                    for (const extra of digForText(msg.opts)) {
                        if (!textParts.includes(extra)) textParts.push(extra)
                    }
                }

                // Kirim ulang media murni (bukan pesan text biasa) apa adanya.
                const isMediaOnly = c.image || c.video || c.document || c.audio || c.sticker
                if (isMediaOnly && conn) {
                    try { await conn.sendMessage(msg.jid, c, msg.opts) } catch (e) {
                        console.warn(`[run_plugin] Gagal kirim ulang media captured dari "${command}": ${e.message}`)
                    }
                }
            }

            const combinedOutput = textParts.filter(Boolean).join('\n\n')
            return `Command ".${command}${args ? ' ' + args : ''}" selesai dijalankan (risiko: ${riskBadge(risk.level)} ${risk.level}).\n\nRAW OUTPUT plugin (JANGAN forward/salin-tempel mentah ke user, ini cuma DATA buat kamu baca):\n${combinedOutput || '(plugin tidak mengirim pesan teks apapun)'}\n\nBalas ke user dengan gaya ngobrol biasa/natural sesuai personamu, SEPENDEK MUNGKIN sesuai apa yang sebenarnya ditanya/diminta user -- BUKAN daftar ulang semua field di atas. Contoh: kalau user cuma bilang "coba ping", jawaban natural cukup semacam "Pong! Respon ~100ms." -- detail RAM/CPU/disk/dst di atas cuma referensi buat kamu, JANGAN ditampilkan kecuali user memang nanya soal itu (atau kamu tawarkan singkat "mau lihat detail server juga?" tanpa langsung dump semuanya).`
        } catch (e) {
            return `${e.message}`
        }
    }
},
{
    name: 'check_plugin_risk',
    description: 'Cek level risiko (⛔ blocked / 🔴 high / 🟡 medium / 🟢 low / ⚪ none) suatu command SEBELUM menjalankannya lewat run_plugin — pakai ini kalau ragu apakah suatu command aman dijalankan otomatis atau butuh konfirmasi/owner dulu. Tidak menjalankan apapun, cuma mengecek.',
    parameters: {
        command: { type: 'string', description: 'Nama fitur/command yang ingin dicek, tanpa prefix. Contoh: "broadcast", "ban", "sticker"', required: true }
    },
    execute: async ({ command }) => {
        const { classifyPluginRisk, execPluginCommand, pluginRequirements, riskBadge } = await getMcp()

        try {
            const { plugins } = await import('../../plugins.js')
            let found = null, foundName = ''
            for (const [name, plugin] of Object.entries(plugins || {})) {
                if (!plugin || typeof plugin !== 'function' || !plugin.command) continue
                const cmd = plugin.command
                const isMatch = cmd instanceof RegExp ? cmd.test(command)
                    : Array.isArray(cmd) ? cmd.some(c => c === command || (c instanceof RegExp && c.test(command)))
                    : cmd === command
                if (isMatch) { found = plugin; foundName = name; break }
            }
            if (!found) return `Command "${command}" tidak ditemukan. Cek dulu dengan list_plugins untuk nama command yang benar.`
            const risk = classifyPluginRisk(foundName, found)
            const reqs = pluginRequirements(found)
            const ownerNote = risk.level === 'high' && !ctx().isOwner ? ' User saat ini BUKAN owner, jadi command ini akan ditolak kalau dicoba run_plugin.' : ''
            const reqNotes = [
                reqs.group ? 'hanya bisa di grup' : '',
                reqs.private ? 'hanya bisa di DM/chat pribadi' : '',
                reqs.premium ? 'butuh status premium' : '',
                reqs.admin ? 'butuh sender jadi admin grup' : '',
                reqs.botAdmin ? 'butuh bot jadi admin grup' : '',
                reqs.limit ? 'pakai limit pemakaian' : '',
            ].filter(Boolean)
            const reqLine = reqNotes.length ? `\nSyarat tambahan: ${reqNotes.join(', ')}.` : ''
            return `Command "${command}" → risiko ${riskBadge(risk.level)} ${risk.level.toUpperCase()} (sumber: ${risk.source || 'floor'}). ${risk.reason}${ownerNote}${reqLine}`
        } catch (e) {
            return `Gagal cek risiko command "${command}": ${e.message}`
        }
    }
},
{
    name: 'read_plugin_guide',
    description: 'Baca panduan internal untuk membuat plugin baru di bot ini. Baca ini dulu sebelum menulis plugin baru.',
    parameters: {},
    execute: async () => {
        const { classifyPluginRisk, execPluginCommand, pluginRequirements, riskBadge } = await getMcp()

        const guides = ['PLUGIN_GUIDE.md', 'PLUGIN_SHORTHAND.md', 'docs/plugin-guide.md', 'README.md']
        for (const g of guides) {
            const abs = path.join(ROOT, g)
            if (fs.existsSync(abs)) {
                const content = fs.readFileSync(abs, 'utf-8').slice(0, 6000)
                return `*${g}*\n\n${content}`
            }
        }

        return [
            '*Panduan Plugin Bot Ini* (built-in, tidak ada PLUGIN_GUIDE.md eksternal)',
            '',
            '```js',
            "import axios from 'axios'",
            '',
            'let handler = async (m, { conn, text, args, usedPrefix, command }) => {',
            '    if (!text) throw `Contoh: ${usedPrefix + command} <input>`',
            '    // ...logic utama plugin di sini...',
            '    await conn.reply(m.chat, "hasil", m)',
            '}',
            '',
            "handler.help = ['namacommand <arg>']",
            "handler.tags = ['kategori']  // main, group, sticker, ai, internet, downloader, owner, dll",
            '',
            '// handler.command BISA regex ATAU array of string — dua-duanya valid:',
            "handler.command = /^(nama|alias)$/i",
            "// ATAU: handler.command = ['nama', 'alias']",
            '',
            'handler.limit = 1        // ANGKA (biaya limit per pakai), BUKAN boolean true/false',
            'handler.owner = false    // true = cuma owner biasa yang bisa',
            'handler.rowner = false   // true = cuma ROwner (root owner) yang bisa',
            'handler.group = false    // true = cuma bisa dipakai di grup',
            'handler.private = false  // true = cuma bisa dipakai di chat pribadi',
            'handler.admin = false    // true = cuma admin grup yang bisa',
            'handler.register = false // true = user WAJIB sudah register dulu',
            'handler.level = 0        // level minimum user (dari db.data.users[jid].level)',
            '',
            'export default handler',
            '```',
            '',
            '*Pola lanjutan:*',
            '- `handler.before = async (m, { conn }) => {...}` — jalan SEBELUM semua plugin lain dicek, dipakai untuk flow bertahap/stateful (mis. plugin download yang nunggu user pilih nomor kualitas setelah link dikirim — simpan state di `conn.someState[m.sender]` dengan timeout cleanup).',
            '- `handler.after = async (m, extra) => {...}` — jalan SETELAH handler utama selesai (sukses maupun error), dipakai untuk cleanup.',
            '- Untuk plugin yang throw string biasa (`throw "pesan error"`) bukan `Error` object, itu valid — dispatcher akan tangkap dan tampilkan sebagai pesan ke user.',
            '- Gunakan `import` ES modules, bukan `require()`, sesuai seluruh codebase.',
        ].join('\n')
    }
}
]
