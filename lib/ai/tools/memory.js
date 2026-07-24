// ─── tools/memory.js ─────────────────────────────────────────────────────────
// Kategori: remember, recall, list_learned, forget, pin_note, unpin_note, list_pinned_notes, log_failure
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'

export default [
{
    name: 'remember',
    description: 'Simpan fakta/pelajaran penting ke memori permanen. Pakai setelah berhasil sesuatu atau dapat info penting dari user.',
    parameters: {
        key:   { type: 'string', description: 'Nama singkat memori (contoh: "cara_restart", "owner_suka_anime")', required: true },
        value: { type: 'string', description: 'Isi pengetahuan yang disimpan', required: true },
        category: { type: 'string', description: 'Kategori: skill, user_pref, system, general', required: false }
    },
    execute: async ({ key, value, category = 'general' }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        const brain = loadBrain()
        const idx = brain.learned.findIndex(m => m.key === key)
        const entry = { key, value, category, saved_at: new Date().toISOString() }
        if (idx >= 0) brain.learned[idx] = entry
        else brain.learned.push(entry)
        saveBrain(brain)
        return `Saved: "${key}" [${category}]`
    }
},
{
    name: 'recall',
    description: 'Cari memori yang relevan berdasarkan kata kunci.',
    parameters: {
        query: { type: 'string', description: 'Kata kunci yang dicari', required: true }
    },
    execute: async ({ query }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        const brain = loadBrain()
        const q = query.toLowerCase()
        const results = brain.learned.filter(m =>
            m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)
        )
        if (!results.length) return `Tidak ada memori tentang "${query}"`
        return results.slice(0, 5).map(m => `[${m.category}] ${m.key}: ${m.value}`).join('\n\n')
    }
},
{
    name: 'list_learned',
    description: `Tampilkan semua yang sudah dipelajari ${process.env.BOT_NAME}. Bisa filter per kategori.`,
    parameters: {
        category: { type: 'string', description: 'Filter: skill, user_pref, system, plugin, general (opsional)', required: false }
    },
    execute: async ({ category } = {}) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        const brain = loadBrain()
        const items = category
            ? brain.learned.filter(m => m.category === category)
            : brain.learned
        if (!items.length) return `${process.env.BOT_NAME} belum punya memori${category ? ` kategori "${category}"` : ''}.`
        const grouped = {}
        items.forEach(m => {
            if (!grouped[m.category]) grouped[m.category] = []
            grouped[m.category].push(m.key)
        })
        let out = `*${process.env.BOT_NAME} Brain* (${items.length} memori)\n\n`
        for (const [cat, keys] of Object.entries(grouped)) {
            out += `*${cat}* (${keys.length})\n`
            out += keys.map(k => `  • ${k}`).join('\n') + '\n\n'
        }
        return out.trim()
    }
},
{
    name: 'forget',
    description: `Hapus memori tertentu dari brain ${process.env.BOT_NAME}.`,
    parameters: {
        key: { type: 'string', description: 'Key memori yang ingin dihapus', required: true }
    },
    execute: async ({ key }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        const brain = loadBrain()
        const before = brain.learned.length
        brain.learned = brain.learned.filter(m => m.key !== key)
        if (brain.learned.length === before) return `Memory "${key}" not found`
        saveBrain(brain)
        return `Memori "${key}" dihapus`
    }
},
{
    name: 'pin_note',
    description: 'Simpan catatan penting yang WAJIB selalu diingat sepanjang CHAT INI (bukan global ke semua chat -- kalau butuh diingat di semua chat, pakai "remember"), kebal dari pemangkasan riwayat chat lama. Pakai untuk fakta krusial yang gak boleh kelupaan meski obrolan sudah panjang (mis. "user ini alergi kacang", "grup ini cuma boleh bahas topik olahraga", "jangan pernah forward media ke nomor X"). JANGAN dipakai untuk obrolan biasa yang gak penting-penting amat.',
    parameters: {
        note: { type: 'string', description: 'Isi catatan yang mau di-pin, ringkas dan jelas.', required: true }
    },
    execute: async ({ note }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        if (!ctx().currentJid) return 'Tidak ada chat aktif.'
        if (!note) return 'note wajib diisi.'
        const brain = loadBrain()
        const slot = ensureBrainGroupSlot(brain, ctx().currentJid)
        if (slot.pinnedNote.includes(note)) return 'Catatan ini sudah ada di daftar pin.'
        slot.pinnedNote.push(note)
        saveBrain(brain)
        return `Dipin (${slot.pinnedNote.length} catatan aktif di chat ini sekarang).`
    }
},
{
    name: 'unpin_note',
    description: 'Hapus catatan yang sebelumnya di-pin di chat ini. Pakai kalau user minta "lupain soal itu" untuk sesuatu yang sudah di-pin.',
    parameters: {
        index: { type: 'number', description: 'Nomor urut catatan yang mau dihapus (lihat dari list_pinned_notes, mulai dari 1).', required: false },
        note_contains: { type: 'string', description: 'Alternatif dari index -- potongan teks dari catatan yang mau dihapus.', required: false }
    },
    execute: async ({ index, note_contains }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        if (!ctx().currentJid) return 'Tidak ada chat aktif.'
        const brain = loadBrain()
        const slot = ensureBrainGroupSlot(brain, ctx().currentJid)
        const pins = slot.pinnedNote
        if (!pins.length) return 'Tidak ada catatan yang di-pin di chat ini.'
        let removeIdx = -1
        if (typeof index === 'number') removeIdx = index - 1
        else if (note_contains) removeIdx = pins.findIndex(p => p.toLowerCase().includes(note_contains.toLowerCase()))
        if (removeIdx < 0 || removeIdx >= pins.length) return 'Catatan tidak ditemukan -- cek dulu pakai list_pinned_notes.'
        const [removed] = pins.splice(removeIdx, 1)
        saveBrain(brain)
        return `Dihapus dari pin: "${removed}"`
    }
},
{
    name: 'list_pinned_notes',
    description: 'Lihat semua catatan yang sedang di-pin di chat ini.',
    parameters: {},
    execute: async () => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        if (!ctx().currentJid) return 'Tidak ada chat aktif.'
        const pins = getPinnedNotesReadOnly(ctx().currentJid)
        if (!pins.length) return 'Belum ada catatan yang di-pin di chat ini.'
        return pins.map((p, i) => `${i + 1}. ${p}`).join('\n')
    }
},
{
    name: 'log_failure',
    description: `Catat percobaan yang gagal ke brain agar tidak diulangi dengan cara yang sama. ${process.env.BOT_NAME} belajar dari kesalahan.`,
    parameters: {
        action:      { type: 'string', description: 'Apa yang dicoba dilakukan', required: true },
        reason:      { type: 'string', description: 'Kenapa gagal / error apa yang terjadi', required: true },
        alternative: { type: 'string', description: 'Alternatif solusi yang mungkin (opsional)', required: false }
    },
    execute: async ({ action, reason, alternative }) => {
        const { ensureBrainGroupSlot, getPinnedNotesReadOnly, loadBrain, saveBrain } = await getMcp()

        const brain = loadBrain()
        if (!brain.failed_attempts) brain.failed_attempts = []
        brain.failed_attempts.push({ action, reason, alternative: alternative || null, logged_at: new Date().toISOString() })
        const key = `jangan_${action.toLowerCase().replace(/\s+/g, '_').slice(0, 40)}`
        brain.learned.push({
            key,
            value: `GAGAL: ${action} → ${reason}${alternative ? `. Coba: ${alternative}` : ''}`,
            category: 'system',
            saved_at: new Date().toISOString(),
            times_recalled: 0
        })
        saveBrain(brain)
        return `Failure logged. Action: ${action} — Reason: ${reason}`
    }
}
]
