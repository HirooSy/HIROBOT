import { ctx, classifyPluginRisk, downloadTwitterDirect, execEval, execPluginCommand, pluginRequirements, resolvePlugin, riskBadge } from '../mcp.js';
import db from '../../database.js'
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'run_eval',
    description: 'Jalankan kode JavaScript custom lewat plugin eval bot (setara mengetik "<< kode" manual di chat). HANYA bisa dipakai oleh REAL OWNER bot (rowner) -- non-owner akan selalu ditolak. TIDAK ADA konfirmasi tambahan sebelum eksekusi (beda dari command risk medium/none lainnya) -- begitu dipanggil, kode LANGSUNG dieksekusi dengan akses penuh ke runtime bot (conn, db, m, dst). Pakai HANYA kalau owner secara eksplisit minta jalankan kode/eval/script tertentu — JANGAN pernah inisiatif sendiri manggil ini tanpa instruksi eksplisit dari owner di turn itu juga.',
    parameters: {
        code: { type: 'string', description: 'Kode JavaScript yang mau dieksekusi, PERSIS seperti yang dimaksud owner (jangan diubah/"diperbaiki" sendiri kecuali diminta). Contoh: \'m.reply("hello world")\'', required: true },
        silent: { type: 'boolean', description: 'true = silent execution (setara prefix "< ", gak ada balasan return value ditampilkan). false/default = tampilkan return value (setara prefix "<< ").', required: false }
    },
    execute: async ({ code, silent = false }) => {
        try {
            await execEval(code, { silent })
            return `[SUDAH TERKIRIM ke user (kode eval sudah dijalankan${silent ? ', silent mode' : ''}). Kalau eksekusinya menghasilkan balasan/output ke chat, itu sudah terkirim langsung oleh plugin -- JANGAN tulis ulang isi output itu. JANGAN kirim teks balasan apapun lagi setelah ini kecuali benar-benar perlu konfirmasi singkat pakai kata-katamu sendiri (mis. "Sudah dijalankan ✅"). Kalau tidak ada yang perlu ditambahkan, cukup jawab dengan string kosong.]`
        } catch (e) {
            return `Gagal menjalankan eval: ${e.message}`
        }
    }
},
{
    name: 'list_plugins',
    description: 'SATU-SATUNYA sumber kebenaran soal command/plugin apa saja yang benar-benar ada di bot ini DAN memang diekspos ke AI (plugin tanpa handler.ai tidak akan muncul di sini sama sekali, karena dianggap sistem/internal-only) — sumber datanya sama persis dengan yang dipakai command ".menu" bawaan bot (plugin.help + plugin.tags), bukan tebakan/ingatan dari nama file atau bot lain. WAJIB dipanggil setiap kali user tanya soal command/fitur/plugin apa saja yang tersedia — JANGAN PERNAH jawab dari ingatan/tebakan karena bot ini TIDAK PUNYA command generik seperti get_random_x atau fitur AI image generation kecuali benar-benar muncul di hasil tool ini. Juga gunakan sebelum run_plugin untuk tahu nama command yang benar. Setiap command ditandai badge risiko untuk AI Agent (banned, high, medium, low, belum diklasifikasi — lihat penjelasan lengkap di deskripsi run_plugin; ini membatasi AI Agent, bukan user) supaya kamu langsung tahu mana yang boleh dijalankan bebas dan mana yang butuh owner/konfirmasi dulu. Kategori yang ada: main, group, sticker, ai, internet, adult, tools, downloader, owner, info.',
    parameters: {
        category: { type: 'string', description: 'Filter kategori/tag (opsional). Contoh: "main", "group", "downloader", "owner"', required: false }
    },
    execute: async ({ category } = {}) => {
        try {
            const { plugins } = await import('../../plugins.js')

            const entries = Object.entries(plugins)

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
            let out = `*Command bot (${totalCmds}, sumber sama dengan .menu):*\n_Flag: [L] limit  [P] premium  [G] group-only  [D] DM-only  [A] admin grup  [B] bot-admin_\n\n`
            for (const [tag, list] of Object.entries(grouped)) {
                out += `*${tag}*\n`
                for (const e of list) {
                    const flags = [
                        e.reqs.limit ? '[L]' : '',
                        e.reqs.premium ? '[P]' : '',
                        e.reqs.group ? '[G]' : '',
                        e.reqs.private ? '[D]' : '',
                        e.reqs.admin ? '[A]' : '',
                        e.reqs.botAdmin ? '[B]' : '',
                    ].filter(Boolean).join('')
                    out += `  • ${e.cmds.join(', ')}${flags ? ` ${flags}` : ''}\n`
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

PENTING: sistem risk level di bawah ini adalah pembatasan untuk AI AGENT (kamu), BUKAN pembatasan untuk user manusia -- user selalu tetap boleh menjalankan command apapun secara manual dengan mengetik langsung di chat (".command"), terlepas dari risk level-nya. Yang dibatasi di sini murni soal command mana yang boleh KAMU jalankan otomatis atas nama user lewat tool ini.

Plugin TANPA handler.ai sama sekali tidak akan pernah bisa dijalankan lewat tool ini (dianggap sistem/internal-only). Untuk plugin yang punya handler.ai, level risikonya DIPERCAYA LANGSUNG dari deklarasi handler.ai.risk + handler.ai.description milik plugin itu sendiri (cek dulu pakai check_plugin_risk kalau ragu, atau lihat badge-nya di list_plugins) — kecuali untuk command sistem paling sensitif (rowner-only, exec/session/secret) yang tetap BANNED keras apapun yang dideklarasikan plugin-nya. CATATAN: handler.ai.summarize menentukan APAKAH hasil plugin ditahan lalu kamu rangkai ulang jadi jawaban natural (true), atau plugin kirim balasannya sendiri langsung ke user dan kamu cukup diam (false/default) — lihat instruksi di dalam tool-result setelah run_plugin dipanggil, ikuti itu:
  banned -> sistem/berbahaya/rowner-only (hard block, gak bisa diubah plugin), ATAU plugin memang tidak punya handler.ai. AI Agent DILARANG KERAS menjalankan ini lewat tool ini, siapapun requester-nya termasuk owner -- ini beda dari melarang user, user tetap boleh ketik manual. Tool ini akan MENOLAK sendiri, jangan dipaksa.
  high -> dideklarasikan plugin sebagai aksi owner-only/masif/destruktif. Dua gate sekaligus: (1) hanya jalan kalau sender adalah owner, (2) SETELAH itu tool ini masih MINTA KONFIRMASI dulu juga (return error "CONFIRM_REQUIRED") -- tanya eksplisit ke owner dulu, baru panggil ulang dengan confirmed: true kalau owner sudah setuju. Beda dari banned: high MASIH BISA jalan asal owner + sudah konfirmasi, banned TIDAK BISA sama sekali apapun kondisinya.
  medium -> dideklarasikan plugin sebagai perubahan state kecil/reversible, boleh siapapun user-nya. Tool ini akan MINTA KONFIRMASI dulu (return error "CONFIRM_REQUIRED") — begitu itu terjadi, TANYA ke user apakah yakin, dan HANYA kalau user sudah bilang setuju secara eksplisit, panggil ulang run_plugin dengan confirmed: true.
  low -> dideklarasikan plugin sebagai aman & idempotent (sticker, ping, downloader, dst) — contoh: "sticker"/"s"/"stiker" HANYA mengonversi gambar/video yang di-reply/attach jadi stiker, "tiktok"/"ig" HANYA download media dari URL publik. Langsung jalankan tanpa ragu, tanpa nanya apapun.
  belum diklasifikasi (none) -> plugin punya handler.ai tapi BELUM mendeklarasikan risk yang valid. JANGAN cuma tanya user boleh-tidaknya seperti medium. Tool ini akan return error "UNCLASSIFIED" berisi path file plugin-nya -- kalau requester saat ini owner, baca source code plugin itu (read_file), tentukan sendiri risk level yang paling sesuai (banned/high/medium/low) dari cara kerja kodenya, lalu tulis balik ke file itu (write_file) mengisi field risk+description di handler.ai (jangan ubah bagian lain), baru panggil ulang run_plugin dengan command yang sama. Kalau requester bukan owner, JANGAN edit file apapun -- beritahu user command ini belum diverifikasi dan perlu dikonfigurasi owner dulu.

Selain risiko, ada syarat konteks terpisah dari flag lain plugin (handler.group, handler.private, handler.premium, handler.admin, handler.botAdmin) yang JUGA otomatis dicek dan bisa bikin tool ini menolak walau risikonya rendah: command grup-only ditolak kalau dipanggil dari DM (dan sebaliknya untuk DM-only), command premium-only ditolak kalau sender bukan premium/owner, command admin-only ditolak kalau sender bukan admin grup ini, command yang butuh bot jadi admin ditolak kalau bot belum admin di grup itu.

Command "menu" sudah dikonfirmasi aman untuk SEMUA user — langsung jalankan tanpa ditanya-tanya dulu, sesuai rule MENU di system prompt. Command sejenis yang belum terverifikasi (misal "help", "allmenu", "list") bisa saja menampilkan command owner-only ke user biasa tergantung implementasi plugin-nya, jadi tool ini menahan command-command itu untuk non-owner secara khusus.

PENTING SOAL PLUGIN MULTI-STEP (mis. "twitter"/"x" downloader): sebagian plugin (biasanya downloader dengan banyak pilihan kualitas/format) bekerja 2 tahap -- run_plugin cuma menjalankan TAHAP PERTAMA (kirim link, plugin balas dengan daftar pilihan bernomor). TAHAP KEDUA (user ketik angka pilihan) DITANGANI LEWAT MEKANISME TERPISAH (handler.before) yang TIDAK BISA dipicu ulang lewat run_plugin -- run_plugin HANYA tahu cara menjalankan command dari awal lagi, bukan cara "melanjutkan" state yang sudah ada.

UNTUK PLUGIN DOWNLOADER TIPE INI, JANGAN PAKAI run_plugin SAMA SEKALI -- pakai tool download_media sebagai gantinya (platform "twitter" di download_media sudah menjalankan scraper-nya langsung, gak lewat flow bernomor). Kalau platform yang diminta user gak didukung di download_media juga, JANGAN coba akali pakai run_plugin buat plugin downloader multi-tahap tersebut (bakal nyangkut di tahap pertama doang) -- kasih tau user platform itu belum didukung buat auto-download lewat AI.`,
    parameters: {
        command: { type: 'string', description: 'Nama command/plugin PERSIS seperti terdaftar (cek list_plugins/check_plugin_risk kalau ragu), tanpa prefix, dan JANGAN diterjemahkan dari maksud natural language user. Contoh: user minta "ping" → command: "ping". PENTING untuk plugin yang formatnya "nama_plugin <argumen>" (lihat handler.help di list_plugins, mis. "simulate <event> [@mention]"): command TETAP nama plugin-nya ("simulate"), argumen setelahnya ("bye", "promote", dst) masuk ke parameter args, BUKAN dijadikan command sendiri. Contoh salah: user bilang "coba simulate bye" lalu dipanggil command:"bye" — ini SALAH karena "bye" bukan nama plugin, itu argumen event untuk plugin "simulate". Contoh benar: command:"simulate", args:"bye".', required: true },
        args: { type: 'string', description: 'Argumen tambahan untuk command (opsional)', required: false },
        confirmed: { type: 'boolean', description: 'Set true HANYA setelah user secara eksplisit menyetujui menjalankan command yang sebelumnya minta konfirmasi (CONFIRM_REQUIRED). Jangan pernah set true duluan tanpa persetujuan user.', required: false }
    },
    execute: async ({ command, args = '', confirmed = false }) => {
        const normalizedCmd = command.trim().toLowerCase()

        

        

        
        if (normalizedCmd === 'twitter' || normalizedCmd === 'x') {
            try {
                const summary = await downloadTwitterDirect(args)
                return `${summary}\nJANGAN tulis ulang detail ini, konfirmasi singkat aja kalau perlu.`
            } catch (e) {
                console.error('[run_plugin] Gagal download twitter (hard redirect):', e)
                return `Gagal download Twitter/X: ${e.message}`
            }
        }

        const MENU_LIKE_UNVERIFIED = ['help', 'allmenu', 'list']
        if (MENU_LIKE_UNVERIFIED.includes(normalizedCmd) && !ctx().isOwner) {

            

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
            } catch (_) { }

            if (!isSameAsMenu) {
                return `Command "${command}" tidak dijalankan otomatis lewat AI untuk non-owner — plugin ini berpotensi menampilkan daftar command owner. Jelaskan fitur bot pakai kata-katamu sendiri saja ke user, atau minta user ketik ".${command}" langsung.`
            }
        }
        try {

            

            

            
            const { plugin: preCheckPlugin } = await resolvePlugin(command)
            const shouldSummarize = preCheckPlugin?.ai?.summarize === true

            const { pluginName, captured, risk: execRisk } = await execPluginCommand(command, args, { confirmed, captureOutput: shouldSummarize })

            
            
            const risk = execRisk || (preCheckPlugin ? classifyPluginRisk(pluginName, preCheckPlugin) : { level: 'none', reason: 'Risk tidak diketahui (fallback).' })

            if (!shouldSummarize) {

                
                const isDownloaderTag = Array.isArray(preCheckPlugin?.tags) && preCheckPlugin.tags.includes('downloader')
                if (isDownloaderTag) {

                    
                    
                    return `[HENTIKAN -- JANGAN PANGGIL run_plugin LAGI UNTUK COMMAND/LINK INI]\nCommand ".${command}${args ? ' ' + args : ''}" (downloader) sudah dijalankan SEKALI dan plugin sudah mengirim balasannya sendiri ke user (biasanya daftar pilihan bernomor kalau ada beberapa format/kualitas, yang TIDAK BISA diselesaikan lewat run_plugin). Tugasmu di sini SELESAI. JANGAN tulis ulang balasan plugin, JANGAN panggil run_plugin lagi dengan command/link yang sama. Kalau platform ini didukung di download_media, pakai tool itu buat menyelesaikan download-nya sekaligus. Kalau tidak, cukup ingatkan user SEKALI untuk balas dengan angka pilihan langsung di chat -- lalu diam, jangan retry apapun.`
                }
                return `Command ".${command}${args ? ' ' + args : ''}" selesai dijalankan (risiko internal: ${risk.level}, JANGAN sebut istilah ini ke user). Plugin sudah mengirim balasannya sendiri langsung ke user -- JANGAN tulis ulang/tambahkan balasan lain soal ini, cukup lanjut ke hal lain kalau ada, atau diam kalau tidak ada lagi yang perlu disampaikan.`
            }

            

            
            const conn = ctx().conn

            

            
            
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

                
                if (msg.opts) {
                    for (const extra of digForText(msg.opts)) {
                        if (!textParts.includes(extra)) textParts.push(extra)
                    }
                }

                const isMediaOnly = c.image || c.video || c.document || c.audio || c.sticker
                if (isMediaOnly && conn) {
                    try { await conn.sendMessage(msg.jid, c, msg.opts) } catch (e) {
                        console.warn(`[run_plugin] Gagal kirim ulang media captured dari "${command}": ${e.message}`)
                    }
                }
            }

            const combinedOutput = textParts.filter(Boolean).join('\n\n')
            return `Command ".${command}${args ? ' ' + args : ''}" selesai dijalankan (risiko internal: ${risk.level}, JANGAN sebut istilah ini ke user).\n\nRAW OUTPUT plugin (JANGAN forward/salin-tempel mentah ke user, ini cuma DATA buat kamu baca):\n${combinedOutput || '(plugin tidak mengirim pesan teks apapun)'}\n\nBalas ke user dengan gaya ngobrol biasa/natural sesuai personamu, SEPENDEK MUNGKIN sesuai apa yang sebenarnya ditanya/diminta user -- BUKAN daftar ulang semua field di atas. Contoh: kalau user cuma bilang "coba ping", jawaban natural cukup semacam "Pong! Respon ~100ms." -- detail RAM/CPU/disk/dst di atas cuma referensi buat kamu, JANGAN ditampilkan kecuali user memang nanya soal itu (atau kamu tawarkan singkat "mau lihat detail server juga?" tanpa langsung dump semuanya).`
        } catch (e) {
            return `${e.message}`
        }
    }
},
{
    name: 'check_plugin_risk',
    description: 'Cek level risiko untuk AI Agent (banned / high / medium / low / belum diklasifikasi) suatu command SEBELUM menjalankannya lewat run_plugin — pakai ini kalau ragu apakah suatu command aman dijalankan otomatis atau butuh konfirmasi/owner dulu. Level ini membatasi AI Agent, BUKAN user (user tetap bisa jalankan command apapun manual di chat). Tidak menjalankan apapun, cuma mengecek.',
    parameters: {
        command: { type: 'string', description: 'Nama fitur/command yang ingin dicek, tanpa prefix. Contoh: "broadcast", "ban", "sticker"', required: true }
    },
    execute: async ({ command }) => {
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
            const ownerNote = risk.level === 'high' ? ' Level HIGH: hanya owner yang boleh menjalankan ini lewat AI Agent, DAN tetap wajib minta konfirmasi eksplisit dulu sebelum run_plugin (confirmed: true) walau requester-nya owner sendiri.' : ''
            const bannedNote = risk.level === 'blocked' ? ' Ini BUKAN larangan untuk user -- user tetap bisa menjalankan command ini manual dengan mengetik langsung di chat. Yang dilarang adalah AI Agent menjalankannya lewat run_plugin.' : ''
            const noneNote = risk.level === 'none' ? ` Plugin file: ${foundName}. Kalau requester owner, baca source-nya (read_file) lalu tentukan risk yang sesuai dan tulis balik ke file ini (write_file) sebelum dijalankan -- lihat rule 6c.` : ''
            const reqNotes = [
                reqs.group ? 'hanya bisa di grup' : '',
                reqs.private ? 'hanya bisa di DM/chat pribadi' : '',
                reqs.premium ? 'butuh status premium' : '',
                reqs.admin ? 'butuh sender jadi admin grup' : '',
                reqs.botAdmin ? 'butuh bot jadi admin grup' : '',
                reqs.limit ? 'pakai limit pemakaian' : '',
            ].filter(Boolean)
            const reqLine = reqNotes.length ? `\nSyarat tambahan: ${reqNotes.join(', ')}.` : ''
            const levelLabel = risk.level === 'blocked' ? 'BANNED' : risk.level.toUpperCase()
            return `Command "${command}" -> risiko internal ${levelLabel} (sumber: ${risk.source || 'floor'}). ${risk.reason}${bannedNote}${ownerNote}${noneNote}${reqLine}\nCATATAN: "${levelLabel}" ini istilah internal buat kamu (AI Agent) doang -- JANGAN PERNAH sebut kata ini atau kata "risk"/"risiko" ke user, balas natural aja (lihat rule 6c).`
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
