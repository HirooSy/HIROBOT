// ─── tools/files.js ─────────────────────────────────────────────────────────
// Kategori: read_file, write_file, list_files, delete_file, move_file, search_files, send_as_file, send_codeblock
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'read_file',
    description: 'Baca isi file di server. Bisa baca config, plugin, .env, dll. Untuk file JSON (package.json, config.json, dll), parsing dan tampilkan dengan format yang lebih rapi. Untuk file BESAR (lebih dari ~100rb karakter), isi dipotong per-bagian — pakai parameter offset untuk ambil bagian selanjutnya (lihat catatan [FILE SANGAT BESAR] di response kalau ini terjadi). Kalau path yang dikasih tidak ketemu PERSIS, tool ini otomatis cari file dengan nama yang mirip di seluruh project dan menawarkan pilihan lewat tombol — TIDAK PERLU manual coba-coba path lain sendiri, cukup panggil tool ini dan biarkan dia yang cari.',
    parameters: {
        file_path: { type: 'string', description: 'Path file. Boleh RELATIF dari root bot (contoh: "plugins/ai.js", "package.json") ATAU ABSOLUT diawali "/" (contoh: "/etc/hosts", "/var/log/syslog") untuk baca file di MANAPUN di server, tidak dibatasi ke folder project. Boleh juga cuma nama file tanpa folder (mis. "profile.js") — tool ini akan cari sendiri lokasinya di dalam project kalau tidak ketemu di root.', required: true },
        offset:    { type: 'number', description: 'Posisi karakter untuk mulai membaca (default 0). Dipakai untuk ambil bagian selanjutnya dari file besar yang terpotong — isi dengan angka yang disebutkan di catatan [FILE SANGAT BESAR] dari pemanggilan read_file sebelumnya.', required: false }
    },
    execute: async ({ file_path, offset = 0 }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const abs = path.resolve(ROOT, file_path)

        if (!fs.existsSync(abs)) {

            const wantedName = path.basename(file_path).toLowerCase()
            const matches = []
            const skipDirs = new Set(['node_modules', '.git', 'sessions', 'tmp'])

            const walk = (dir, depth = 0) => {
                if (depth > 6 || matches.length >= 8) return
                let entries
                try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
                for (const ent of entries) {
                    if (matches.length >= 8) return
                    if (ent.isDirectory()) {
                        if (skipDirs.has(ent.name)) continue
                        walk(path.join(dir, ent.name), depth + 1)
                    } else if (ent.name.toLowerCase() === wantedName) {
                        matches.push(path.relative(ROOT, path.join(dir, ent.name)))
                    }
                }
            }
            walk(ROOT)

            if (matches.length === 1) {

                return await readFileToolCore(matches[0], offset)
            }

            if (matches.length > 1) {
                const btnList = matches.slice(0, 8).map(m => ({ type: 'reply', label: m.length > 24 ? '…' + m.slice(-23) : m, value: `baca file ${m}` }))
                return `File "${file_path}" tidak ketemu persis. Ditemukan ${matches.length} kandidat dengan nama sama: ${matches.slice(0, 8).join(', ')}.\n\n` +
                    `Tawarkan pilihan ini ke user lewat tombol — balas dengan JSON __type:"buttons" ini SEBAGAI SATU-SATUNYA ISI RESPONMU (tanpa teks lain di luar JSON):\n` +
                    JSON.stringify({ __type: 'buttons', body: `File "${file_path}" nggak ketemu persis. Yang mana nih?`, buttons: btnList })
            }

            return `File tidak ditemukan: ${file_path} (sudah dicari juga di seluruh project, tidak ada file dengan nama "${wantedName}")`
        }

        return await readFileToolCore(file_path, offset)
    }
},
{
    name: 'write_file',
    description: 'Tulis/overwrite isi file di server. Otomatis backup dulu sebelum ditimpa. JANGAN PERNAH pakai tool ini untuk permintaan "kirim/tampilkan/lihat isi file X" — itu HARUS pakai read_file lalu send_codeblock/send_as_file (tool ini TIDAK mengirim apapun ke chat, cuma menulis ke disk server). write_file HANYA untuk saat user secara eksplisit minta MENGUBAH/MENGEDIT isi file (mis. "ganti versi di package.json jadi 2.0", "tambahin fungsi X di file Y"). Salah pakai tool ini untuk sekadar "menampilkan" file pernah betulan menimpa file asli user dengan versi yang salah/lebih pendek — SELALU pastikan konten yang ditulis adalah PERSIS yang diinginkan user, JANGAN menulis ulang dari ingatan/asumsi sendiri.',
    parameters: {
        file_path: { type: 'string', description: 'Path file. Boleh RELATIF dari root bot ATAU ABSOLUT diawali "/" untuk tulis ke file manapun di server (tidak dibatasi ke folder project) — hati-hati kalau menulis di luar project, pastikan memang itu yang diminta user.', required: true },
        content:   { type: 'string', description: 'Isi file yang akan ditulis', required: true }
    },
    execute: async ({ file_path, content }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const abs = path.resolve(ROOT, file_path)
        const existed = fs.existsSync(abs)
        const oldContent = existed ? fs.readFileSync(abs, 'utf-8') : ''


        if (existed && oldContent.length > 200) {
            const shrinkRatio = 1 - (content.length / oldContent.length)
            if (shrinkRatio > 0.2) {
                const diff = buildSimpleDiff(oldContent, content)
                if (_autoHealActive && _autoHealNotifyJid && ctx().conn) {
                    try {
                        await ctx().conn.sendMessage(_autoHealNotifyJid, {
                            text: `*Auto-Heal DIBATALKAN* untuk ${file_path}\n\n` +
                                  `Perubahan akan memangkas file dari ${oldContent.length} → ${content.length} chars ` +
                                  `(${Math.round(shrinkRatio * 100)}% lebih pendek). Ini pola yang sama seperti insiden ` +
                                  `sebelumnya (logic penting terhapus diam-diam), jadi ditolak otomatis dan butuh review manual.\n\n` +
                                  `Diff (ringkas):\n${diff.slice(0, 1500)}`
                        })
                    } catch (_) {}
                }
                return `REJECTED: change would shrink ${file_path} by ${Math.round(shrinkRatio * 100)}% ` +
                       `(${oldContent.length} → ${content.length} chars). Ini biasanya tanda konten/logic terhapus tanpa ` +
                       `sengaja (mis. AI menulis ulang dari ingatannya sendiri alih-alih menyalin isi asli), bukan edit ` +
                       `wajar. Kalau MEMANG file sebaiknya jadi lebih pendek (mis. refactor/hapus dead code yang ` +
                       `disengaja), jelaskan alasannya secara eksplisit ke user dan minta konfirmasi dulu sebelum ` +
                       `write_file dipanggil lagi — tidak akan menimpa file sebesar ini secara otomatis.`
            }
        }


        if (existed) {
            const backupDir = path.join(ROOT, 'data', 'backups')
            fs.mkdirSync(backupDir, { recursive: true })
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const backupName = file_path.replace(/[/\\]/g, '__') + '.' + stamp + '.bak'
            fs.copyFileSync(abs, path.join(backupDir, backupName))
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf-8')


        if (_autoHealActive && _autoHealNotifyJid && ctx().conn && existed) {
            const diff = buildSimpleDiff(oldContent, content)
            try {
                await ctx().conn.sendMessage(_autoHealNotifyJid, {
                    text: `Auto-heal wrote ${file_path} (${oldContent.length} -> ${content.length} chars)\n\nDiff:\n${diff.slice(0, 1500)}`
                })
            } catch (_) {}
        }

        return `Written: ${file_path} (${content.length} chars)`
    }
},
{
    name: 'list_files',
    description: 'Lihat isi folder di server. Bisa dipakai untuk folder manapun di seluruh sistem, tidak dibatasi ke folder project bot.',
    parameters: {
        dir_path: { type: 'string', description: 'Path folder. RELATIF dari root bot (default: "." = root project) ATAU ABSOLUT diawali "/" (contoh: "/", "/etc", "/home") untuk lihat direktori manapun di server.', required: false }
    },
    execute: async ({ dir_path = '.' }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const abs = path.resolve(ROOT, dir_path)
        if (!fs.existsSync(abs)) return `Folder not found: ${dir_path}`
        const entries = fs.readdirSync(abs, { withFileTypes: true })
        const list = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')
        return `${dir_path}:\n${list}`
    }
},
{
    name: 'delete_file',
    description: 'Hapus file dari server.',
    parameters: {
        file_path: { type: 'string', description: 'Path file yang akan dihapus. RELATIF dari root bot ATAU ABSOLUT diawali "/" untuk hapus file manapun di server. HATI-HATI kalau di luar project — pastikan memang diminta user.', required: true }
    },
    execute: async ({ file_path }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const abs = path.resolve(ROOT, file_path)
        if (!fs.existsSync(abs)) return `File not found: ${file_path}`
        if (fs.statSync(abs).isDirectory()) return `${file_path} is a directory`
        fs.unlinkSync(abs)
        return `File dihapus: ${file_path}`
    }
},
{
    name: 'move_file',
    description: 'Pindahkan atau rename file/folder di server.',
    parameters: {
        from: { type: 'string', description: 'Path sumber. RELATIF dari root bot ATAU ABSOLUT diawali "/" untuk file/folder manapun di server.', required: true },
        to:   { type: 'string', description: 'Path tujuan. RELATIF dari root bot ATAU ABSOLUT diawali "/".', required: true }
    },
    execute: async ({ from, to }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const src = path.resolve(ROOT, from)
        const dst = path.resolve(ROOT, to)
        if (!fs.existsSync(src)) return `Tidak ditemukan: ${from}`
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.renameSync(src, dst)
        return `${from} -> ${to}`
    }
},
{
    name: 'search_files',
    description: 'Cari file berdasarkan nama di server. Bisa cari di seluruh sistem lewat parameter folder absolut, tidak dibatasi ke folder project.',
    parameters: {
        query:  { type: 'string', description: 'Nama atau bagian nama file', required: true },
        folder: { type: 'string', description: 'Folder pencarian. RELATIF dari root bot (default: ".") ATAU ABSOLUT diawali "/" untuk cari di direktori manapun di server.', required: false }
    },
    execute: async ({ query, folder = '.' }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        const target = path.resolve(ROOT, folder)
        const results = []
        const fmt = (b) => b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`
        function walk(dir, depth = 0) {
            if (depth > 6) return
            try {
                for (const item of fs.readdirSync(dir)) {
                    if (['node_modules', '.git'].includes(item)) continue
                    const full = path.join(dir, item)
                    const rel  = full.startsWith(ROOT) ? path.relative(ROOT, full) : full
                    if (item.toLowerCase().includes(query.toLowerCase())) {
                        const s = fs.statSync(full)
                        results.push(`${rel}${s.isFile() ? ` (${fmt(s.size)})` : ''}`)
                    }
                    try { if (fs.statSync(full).isDirectory()) walk(full, depth + 1) } catch {}
                }
            } catch {}
        }
        walk(target)
        if (!results.length) return `Tidak ada file cocok dengan "${query}"`
        return `"${query}" — ${results.length} hasil:\n\n${results.slice(0, 40).join('\n')}`
    }
},
{
    name: 'send_as_file',
    description: 'Kirim konten sebagai FILE ATTACHMENT (dokumen) di WhatsApp, bukan sebagai pesan teks/card. PAKAI TOOL INI (bukan send_codeblock) kalau file/kode yang mau ditampilkan CUKUP BESAR sehingga send_codeblock perlu dipanggil berkali-kali (lebih dari ~1-2 bagian) — mengirim banyak card send_codeblock berturut-turut bikin chat lag dan berat di HP user. Attachment dokumen jauh lebih ringan untuk file besar: user tinggal buka/simpan filenya, tidak perlu scroll banyak pesan. Untuk file KECIL yang muat dalam satu send_codeblock, tetap pakai send_codeblock (ada syntax highlighting-nya, lebih enak dibaca langsung di chat).\n\nPENTING soal parameter "content": kalau file_path menunjuk file YANG SUDAH ADA di server (reproduksi file existing, bukan bikin baru), KOSONGKAN parameter content — tool ini akan baca file itu LANGSUNG DARI DISK sendiri, dijamin persis tanpa risiko kepotong/salah ketik. Isi parameter content secara manual HANYA kalau memang itu konten yang kamu compose/susun sendiri dari nol (bukan reproduksi file existing).',
    parameters: {
        file_path: { type: 'string', description: 'Path file. Kalau file ini SUDAH ADA di server dan content dikosongkan, path ini juga dipakai buat baca isinya langsung dari disk (boleh relatif dari root ATAU absolut diawali "/"). Kalau cuma nama tampilan untuk konten baru yang kamu compose sendiri, boleh nama bebas.', required: true },
        content:   { type: 'string', description: 'Isi lengkap file yang akan dikirim sebagai attachment. OPSIONAL — kosongkan kalau file_path menunjuk file yang sudah ada di server (biar dibaca langsung dari disk, lebih aman). Isi manual HANYA untuk konten yang kamu susun/generate sendiri dari nol.', required: false },
        caption:   { type: 'string', description: 'Teks singkat yang menyertai file (opsional) — mis. "Ini dia mcp.js, ~146rb karakter"', required: false }
    },
    execute: async ({ file_path, content, caption }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!file_path) return 'file_path is required'

        let finalContent = content
        if (!finalContent) {


            if (!ctx().isOwner) return 'Content kosong (mode baca-dari-disk) cuma boleh untuk owner. Isi parameter content manual dengan konten yang mau dikirim.'
            const abs = path.resolve(ROOT, file_path)
            if (!fs.existsSync(abs)) return `Content kosong dan file tidak ditemukan di disk: ${file_path}. Isi parameter content manual, atau pastikan file_path benar (boleh path absolut).`
            if (fs.statSync(abs).isDirectory()) return `${file_path} adalah folder, bukan file. Kasih path ke file-nya.`
            finalContent = fs.readFileSync(abs, 'utf-8')
        }
        if (!finalContent) return 'Content cannot be empty'


        const ext = (file_path.split('.').pop() || '').toLowerCase()
        const mimeByExt = {
            js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
            json: 'application/json', html: 'text/html', css: 'text/css',
            py: 'text/x-python', md: 'text/markdown', txt: 'text/plain',
            env: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml',
            sh: 'text/x-sh', sql: 'text/plain', xml: 'text/xml'
        }
        const mimetype = mimeByExt[ext] || 'text/plain'
        const fileName = file_path.includes('/') ? file_path.split('/').pop() : file_path

        try {
            await ctx().conn.sendMessage(ctx().currentJid, {
                document: Buffer.from(finalContent, 'utf-8'),
                mimetype,
                fileName,
                caption: caption || undefined
            }, { quoted: ctx().currentM })

            return `File "${fileName}" (${finalContent.length} chars) sent as attachment.`
        } catch (e) {
            console.error('[send_as_file] Error:', e)
            return `Failed to send file: ${e.message}. Try send_codeblock instead.`
        }
    }
},
{
    name: 'send_codeblock',
    description: 'Kirim isi FILE YANG SUDAH ADA di server sebagai code block dengan syntax highlighting di chat WhatsApp. WAJIB PAKAI TOOL INI setiap kali user minta lihat isi file yang SUDAH ADA (mis. "lihat isi package.json", "kasih liat kode ai.js") dan ukurannya kecil (~di bawah 4000 karakter) — CUKUP kasih file_path, JANGAN ketik ulang isinya sendiri ke parameter manapun. Tool ini baca file LANGSUNG DARI DISK, dijamin persis karakter-per-karakter, tidak mungkin kepotong/salah ketik seperti kalau kamu reproduksi manual. Kalau file ternyata kebesaran, tool ini kasih tau supaya kamu pakai send_as_file(file_path) sebagai gantinya (juga tanpa perlu ketik ulang isinya). Untuk kode yang KAMU TULIS SENDIRI dari nol (bukan reproduksi file existing), tetap pakai format JSON manual {"__type":"codeblock",...} di jawaban akhir seperti biasa — tool ini KHUSUS untuk file yang sudah ada di disk.',
    parameters: {
        file_path:   { type: 'string', description: 'Path file yang mau ditampilkan isinya. Boleh relatif dari root bot ATAU absolut diawali "/". Isi dibaca langsung dari disk oleh tool ini — jangan salin isinya secara manual ke parameter lain.', required: true },
        title:       { type: 'string', description: 'Judul yang ditampilkan di atas kode (opsional, default nama file)', required: false },
        description: { type: 'string', description: 'Penjelasan singkat opsional di atas kode', required: false }
    },
    execute: async ({ file_path, title, description }) => {
        const { buildSimpleDiff, readFileToolCore } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!file_path) return 'file_path is required'

        const abs = path.resolve(ROOT, file_path)
        if (!fs.existsSync(abs)) return `File tidak ditemukan: ${file_path}`
        if (fs.statSync(abs).isDirectory()) return `${file_path} adalah folder, bukan file.`

        const content = fs.readFileSync(abs, 'utf-8')
        if (content.length > 4000) {
            return `File "${file_path}" terlalu besar untuk codeblock (${content.length} chars, limit ~4000 biar nggak berat di chat). Pakai tool send_as_file dengan file_path yang sama (kosongkan content) sebagai gantinya — tidak perlu baca ulang manual.`
        }

        const ext = (file_path.split('.').pop() || '').toLowerCase()
        const langByExt = {
            js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json',
            html: 'html', css: 'css', py: 'python', md: 'markdown', sh: 'bash',
            sql: 'sql', yml: 'yaml', yaml: 'yaml', env: 'text', txt: 'text', xml: 'xml'
        }
        const language = langByExt[ext] || 'text'
        const fileName = file_path.includes('/') ? file_path.split('/').pop() : file_path

        try {
            const rich = ctx().conn.aiRich()
            rich.setTitle(title || fileName)
            if (description) rich.addText(description + '\n', { hyperlink: true })
            rich.addCode(language, content)
            await rich.send(ctx().currentJid, { quoted: ctx().currentM })
            return `Codeblock "${fileName}" (${content.length} chars) terkirim.`
        } catch (e) {
            try {
                const msg = (title ? `*${title}*\n\n` : '') + (description ? `${description}\n\n` : '') + '```' + language + '\n' + content + '\n```'
                await ctx().conn.sendMessage(ctx().currentJid, { text: msg }, { quoted: ctx().currentM })
                return `Codeblock "${fileName}" terkirim (fallback teks biasa).`
            } catch (e2) {
                console.error('[send_codeblock] Error:', e2)
                return `Gagal kirim codeblock: ${e2.message}`
            }
        }
    }
}
]
