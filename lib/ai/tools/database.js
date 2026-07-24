// ─── tools/database.js ─────────────────────────────────────────────────────────
// Kategori: read_database, write_database
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'

export default [
{
    name: 'read_database',
    description: 'Baca struktur/isi database bot (db.data) yang lagi berjalan — baca LANGSUNG dari memory, jadi tetap bekerja apapun jenis adapternya (JSON file lokal, MongoDB, MySQL, Cloud DB). Pakai ini untuk cek struktur data ASLI (nama key/field, tipe value, contoh isi) pas debugging/auto-heal — jangan nebak dari kode doang, apalagi kalau error-nya menyangkut db.data. Catatan: read_file cuma bisa baca database.json kalau adapternya file lokal; untuk adapter remote (Mongo/MySQL/Cloud DB) read_database ini SATU-SATUNYA cara lihat isinya. Field "password" otomatis disamarkan demi keamanan.',
    parameters: {
        key_path: { type: 'string', description: 'Path key di db.data. Dot notation biasa untuk key tanpa titik, mis. "users" (semua user), "settings". KHUSUS key yang mengandung TITIK (paling sering JID WhatsApp) WAJIB dibungkus bracket+quote biar tidak kepotong salah, contoh: \'users["6281234567890@s.whatsapp.net"]\' (satu user spesifik), \'chats["1234@g.us"].settings\'. (Ada fallback auto-merge kalau lupa bracket, tapi bracket lebih pasti benar.) Kosongkan untuk lihat daftar top-level key beserta jumlah entrinya dulu.', required: false },
        limit: { type: 'number', description: 'Kalau hasilnya object berisi banyak entri (mis. semua users), batasi jumlah entri yang ditampilkan (default 5) biar tidak boros token — panggil lagi dengan key_path lebih spesifik untuk lihat entri tertentu.', required: false }
    },
    execute: async ({ key_path = '', limit = 5 }) => {
        const { parseDbKeyPath } = await getMcp()

        if (!db?.data) return 'GAGAL: db.data belum siap (belum ter-load) — pastikan await db.read() sudah jalan.'

        if (!key_path) {
            const summary = Object.entries(db.data).map(([k, v]) => {
                const count = v && typeof v === 'object' ? Object.keys(v).length : ''
                return `- ${k}${count !== '' ? ` (${count} entri)` : ''}`
            }).join('\n')
            return `Top-level keys di db.data:\n${summary}\n\nPanggil lagi dengan key_path (mis. "users") untuk lihat isinya.`
        }

        const parts = parseDbKeyPath(key_path)
        if (!parts.length) return 'GAGAL: key_path tidak valid.'
        let node = db.data
        for (const p of parts) {
            if (node == null || typeof node !== 'object' || !(p in node)) {
                return `GAGAL: "${key_path}" tidak ditemukan di db.data.`
            }
            node = node[p]
        }

        const redact = (obj) => {
            if (Array.isArray(obj)) return obj.map(redact)
            if (obj && typeof obj === 'object') {
                const out = {}
                for (const [k, v] of Object.entries(obj)) {
                    out[k] = (k === 'password') ? '[REDACTED]' : redact(v)
                }
                return out
            }
            return obj
        }

        let result = redact(node)
        let note = ''
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            const entries = Object.entries(result)
            if (entries.length > limit) {
                result = Object.fromEntries(entries.slice(0, limit))
                note = `\n\n[Ditampilkan ${limit} dari ${entries.length} entri — panggil lagi dengan key_path lebih spesifik (mis. "users.<salah satu key di atas>") atau limit lebih besar kalau perlu lihat sisanya.]`
            }
        }

        return `db.data.${key_path}:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`${note}`
    }
},
{
    name: 'write_database',
    description: 'Ubah/hapus isi database bot (db.data) yang lagi berjalan — langsung dari memory, sama seperti "db.data.users[user].name = \\"Hiro\\"" di kode. JANGAN PERNAH pakai write_file untuk mengedit database (mis. database.json) — itu cuma nulis file di disk, TIDAK sinkron dengan db.data yang lagi jalan di memory, dan bisa membuat data korup/ke-overwrite balik apapun adapternya (JSON lokal, MongoDB, MySQL, Cloud DB). write_database ini SATU-SATUNYA cara yang benar untuk edit database, karena otomatis persist lewat db.write() (adapternya apapun). OWNER-ONLY — user biasa tidak boleh pakai tool ini.',
    parameters: {
        key_path: { type: 'string', description: 'Path key di db.data, sama seperti dipakai di read_database. Boleh dot notation biasa untuk key tanpa titik, mis. "settings.prefix". KHUSUS key yang mengandung TITIK (paling sering JID WhatsApp, mis. "628xxx@s.whatsapp.net", "1234@g.us") WAJIB dibungkus bracket+quote supaya tidak kepotong salah, contoh: \'users["628xxx@s.whatsapp.net"].name\', \'chats["1234@g.us"].settings.welcome\'. (Ada fallback auto-merge kalau lupa bracket, tapi bracket lebih aman/pasti benar.) Kalau key perantara belum ada, otomatis dibuatkan sebagai object kosong (kecuali operation "delete") — hasilnya akan kasih WARNING kalau ini bikin record users/chats baru, cek warning itu untuk pastikan bukan salah ketik.', required: true },
        value: { type: 'string', description: 'Nilai baru, dalam bentuk JSON literal (string harus pakai tanda kutip ganda, mis. "Hiro"; angka: 5; boolean: true; object: {"a":1}; array: [1,2,3]). Wajib diisi kalau operation "set" (default). Diabaikan kalau operation "delete".', required: false },
        operation: { type: 'string', description: '"set" (default) untuk mengubah/menambah value baru, atau "delete" untuk menghapus key tersebut sepenuhnya dari db.data.', required: false }
    },
    execute: async ({ key_path, value, operation = 'set' }) => {
        const { parseDbKeyPath } = await getMcp()

        if (!db?.data) return 'GAGAL: db.data belum siap (belum ter-load) — pastikan await db.read() sudah jalan.'
        if (!key_path) return 'GAGAL: key_path wajib diisi.'

        const parts = parseDbKeyPath(key_path)
        if (!parts.length) return 'GAGAL: key_path tidak valid.'

        const lastKey = parts[parts.length - 1]
        let node = db.data

        if (operation === 'delete') {
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i]
                if (node == null || typeof node !== 'object' || !(p in node)) {
                    return `GAGAL: path "${key_path}" tidak ditemukan di db.data.`
                }
                node = node[p]
            }
            if (node == null || typeof node !== 'object' || !(lastKey in node)) {
                return `GAGAL: key "${key_path}" tidak ditemukan di db.data.`
            }
            const oldVal = node[lastKey]
            delete node[lastKey]
            try {
                if (typeof db.write === 'function') await db.write()
            } catch (e) {
                node[lastKey] = oldVal 
                return `GAGAL menyimpan perubahan ke database: ${e.message}`
            }
            return `Deleted: db.data.${key_path}\n(nilai lama: ${JSON.stringify(oldVal)})`
        }


        if (value === undefined) return 'GAGAL: value wajib diisi untuk operation "set".'
        let parsedValue
        try {
            parsedValue = JSON.parse(value)
        } catch (_) {


            parsedValue = value
        }






        let autoCreatedWarning = ''
        if (parts.length >= 2 && (parts[0] === 'users' || parts[0] === 'chats')) {
            const collection = db.data[parts[0]]
            if (collection && typeof collection === 'object' && !(parts[1] in collection)) {
                autoCreatedWarning = `\n\n⚠️ PERINGATAN: record "${parts[0]}.${parts[1]}" SEBELUMNYA TIDAK ADA di database, jadi baru dibuat otomatis sebagai object kosong. Kalau maksudnya edit user/chat yang SUDAH ADA, ini kemungkinan besar key_path salah (JID salah ketik, atau lupa bracket-quote untuk JID yang mengandung titik) — cek lagi pakai read_database sebelum lanjut.`
            }
        }
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i]
            if (node[p] == null || typeof node[p] !== 'object') {
                node[p] = {}
            }
            node = node[p]
        }

        const oldVal = node[lastKey]
        node[lastKey] = parsedValue
        try {
            if (typeof db.write === 'function') await db.write()
        } catch (e) {
            node[lastKey] = oldVal 
            return `GAGAL menyimpan perubahan ke database: ${e.message}`
        }
        return `Set: db.data.${key_path} = ${JSON.stringify(parsedValue)}\n(nilai lama: ${JSON.stringify(oldVal)})${autoCreatedWarning}`
    }
}
]
