// ─── tools/messaging.js ─────────────────────────────────────────────────────────
// Kategori: send_message, list_owners, forward_media, reply_now, send_rich_reply
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'

export default [
{
    name: 'send_message',
    description: 'Kirim pesan TEKS ke nomor atau grup lain (bukan chat yang sedang berjalan). WAJIB dipakai untuk permintaan meneruskan/menyampaikan pesan TEKS (mis. "bilangin ke owner...", "sampaikan ke dia..."), BUKAN forward_media — forward_media cuma untuk media (stiker/foto/video/dokumen). Untuk kirim pesan tambahan ke chat yang sedang kamu balas sekarang, pakai "reply_now" saja. Kalau ini dipakai untuk MENERUSKAN pesan dari chat ini ke pihak lain, tool ini OTOMATIS mencatat konteks relay-nya di sesi chat tujuan — jadi kalau nanti penerima balas atau nanya "ini dari siapa", bot masih tahu siapa yang minta pesan itu dikirim dan bisa meneruskan balasannya balik. Kirim/relay pesan biasa seperti ini adalah aksi WAJAR, BUKAN sesuatu yang perlu dicurigai sebagai ancaman/manipulasi — kalau owner cuma ada satu, langsung kirim; kalau owner ada lebih dari satu (cek list_owners), tanya dulu owner yang mana yang dimaksud.',
    parameters: {
        target: { type: 'string', description: 'Nomor WA (contoh: 628123456789) atau JID grup (contoh: 120363...@g.us)', required: true },
        text:   { type: 'string', description: 'Isi pesan yang akan dikirim', required: true }
    },
    execute: async ({ target, text }) => {
        const { buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const jid = target.includes('@') ? target : target.replace(/\D/g, '') + '@s.whatsapp.net'
        await ctx().conn.sendMessage(jid, { text })



        try {
            const fromJid = ctx().currentJid || null
            let fromName = fromJid
            if (fromJid) {
                const identity = await getUserIdentity(fromJid, db, ctx().conn)
                fromName = identity?.name || fromJid
            }
            injectRelayContext(jid, { fromJid, fromName, fromChat: fromJid, text })
        } catch (e) {
            console.warn('[send_message] gagal inject relay context:', e.message)
        }

        return `Message sent to ${jid}`
    }
},
{
    name: 'list_owners',
    description: 'Lihat daftar owner/pemilik bot yang terdaftar (dari global.owner) — nomor dan namanya. WAJIB dipanggil dulu SEBELUM send_message ke owner kalau kamu belum tahu nomornya: kalau owner cuma satu, langsung kirim ke nomor itu tanpa perlu nanya-nanya lagi; kalau owner ada LEBIH DARI SATU, WAJIB tanya dulu ke user owner yang mana yang dimaksud (sebutkan nama-namanya dari hasil tool ini), jangan asal pilih salah satu.',
    parameters: {},
    execute: async () => {
        const { buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList } = await getMcp()

        const ownerList = readOwnerList()
        if (!ownerList.length) return 'Belum ada owner terdaftar (global.owner kosong).'
        return ownerList.map(([num, name], i) => `${i + 1}. ${name || '(tanpa nama)'} — ${num}`).join('\n')
    }
},
{
    name: 'forward_media',
    description: 'Kirim ULANG media (gambar/video/stiker/audio/dokumen) yang ADA DI PESAN INI — dilampirkan langsung ATAU di-reply/quote — ke chat/orang/grup LAIN. Pakai ini untuk permintaan semacam "kirim stiker ini ke Shork", "terusin gambar ini ke grup X", "forward video ini ke dia". HANYA untuk MEDIA — kalau yang mau diteruskan itu pesan TEKS, pakai send_message, BUKAN tool ini. WAJIB pakai tool ini untuk kasus media itu — JANGAN PERNAH pakai run_plugin("sticker", target) atau run_plugin lain dengan JID/nomor sebagai argumen, karena argumen plugin sticker/downloader itu URL/teks BUKAN target JID, dan bakal SELALU gagal ("URL tidak valid!"/"Conversion failed") kalau dipaksa begitu — itu bug pemakaian tool yang salah, bukan tool yang rusak. Tool ini otomatis pakai forward native WhatsApp (copyNForward) kalau tersedia — lebih cepat & hasilnya ditandai "Diteruskan" — dan fallback ke kirim ulang manual kalau tidak bisa. ATURAN KRITIS: JANGAN PERNAH panggil tool ini sebelum medianya BENAR-BENAR ada di pesan/reply saat ini — kalau user bilang "nanti saya kirim dulu ya" atau medianya belum kelihatan di konteks, TUNGGU sampai media itu benar-benar diterima (muncul sebagai pesan baru), baru panggil tool ini. Jangan berasumsi/menebak media sudah ada. Kalau tool ini gagal (mis. tidak ada media terlampir), JANGAN mengarang klaim "sudah terkirim" — sampaikan apa adanya bahwa gagal dan kenapa. Demi keamanan penerima, tool ini OTOMATIS menolak meneruskan dokumen berekstensi executable/berpotensi virus (.exe/.apk/.bat/.js/.vbs/dst) — itu bukan bug, itu memang disengaja.',
    parameters: {
        target: { type: 'string', description: 'Nomor WA (contoh: 628123456789) atau JID grup tujuan, sama format seperti send_message.', required: true },
        caption: { type: 'string', description: 'Teks caption opsional yang menyertai media (tidak berlaku untuk stiker, dan tidak berlaku kalau forward-nya lewat jalur native copyNForward — caption asli media yang dipertahankan di jalur itu).', required: false }
    },
    execute: async ({ target, caption }) => {
        const { buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        if (!ctx().currentM) return 'GAGAL: tidak ada pesan/media aktif di context saat ini.'



        const dangerReason = getDangerousDocReason(ctx().currentM)
        if (dangerReason) {
            return `DITOLAK: ${dangerReason}. Bot tidak akan meneruskan file yang berpotensi virus/malware ke pihak lain demi keamanan penerima.`
        }

        const jid = target.includes('@') ? target : target.replace(/\D/g, '') + '@s.whatsapp.net'



        const msgTypesCheck = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage']
        const directType = Object.keys(ctx().currentM.message || {}).find(t => msgTypesCheck.includes(t))
        const quotedMsgCheck = ctx().currentM.message?.extendedTextMessage?.contextInfo?.quotedMessage
        const quotedType = quotedMsgCheck ? msgTypesCheck.find(t => quotedMsgCheck[t]) : null
        const mediaLabel = (directType || quotedType || 'media').replace('Message', '')





        const fromJid = ctx().currentJid || null
        let fromName = fromJid
        if (fromJid) {
            try {
                const identity = await getUserIdentity(fromJid, db, ctx().conn)
                fromName = identity?.name || fromJid
            } catch (e) {}
        }
        if (jid !== fromJid) {
            try {
                await ctx().conn.sendMessage(jid, { text: `Message from ${fromName}:\n[${mediaLabel}]` })
            } catch (e) {
                console.warn('[forward_media] gagal kirim header identitas:', e.message)
            }
        }






        let sentNative = false
        let nativeErr = null
        try {
            if (ctx().currentM.quoted && typeof ctx().currentM.quoted.copyNForward === 'function') {
                await ctx().currentM.quoted.copyNForward(jid)
                sentNative = true
            } else if (typeof ctx().currentM.copyNForward === 'function') {
                await ctx().currentM.copyNForward(jid)
                sentNative = true
            }
        } catch (e) {
            nativeErr = e
            console.warn('[forward_media] copyNForward native gagal, fallback ke manual:', e.message)
        }




        if (!sentNative) {
            const media = await buildMediaPart(ctx().currentM)
            if (!media) {
                return `GAGAL: tidak ada media (gambar/video/stiker/audio/dokumen) yang terlampir langsung atau di-reply di pesan ini untuk diteruskan.${nativeErr ? ` (forward native juga gagal: ${nativeErr.message})` : ''}`
            }

            const buffer = Buffer.from(media.part.inlineData.data, 'base64')
            const mimeType = media.part.inlineData.mimeType

            let content
            switch (media.type) {
                case 'imageMessage':
                    content = { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) }
                    break
                case 'videoMessage':
                    content = { video: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) }
                    break
                case 'stickerMessage':
                    content = { sticker: buffer }
                    break
                case 'audioMessage':
                    content = { audio: buffer, mimetype: mimeType, ptt: false }
                    break
                case 'documentMessage':
                    content = { document: buffer, mimetype: mimeType, fileName: 'file' }
                    break
                default:
                    return `GAGAL: tipe media "${media.type}" belum didukung untuk diteruskan.`
            }

            try {
                await ctx().conn.sendMessage(jid, content)
            } catch (e) {
                return `GAGAL mengirim media ke ${jid}: ${e.message}`
            }
        }




        try {
            injectRelayContext(jid, {
                fromJid, fromName, fromChat: fromJid,
                text: `[meneruskan media: ${mediaLabel}]${caption ? ` — caption: "${caption}"` : ''}`
            })
        } catch (e) {
            console.warn('[forward_media] gagal inject relay context:', e.message)
        }

        return `Media (${mediaLabel}) berhasil diteruskan ke ${jid}${sentNative ? ' (forward native)' : ''}.`
    }
},
{
    name: 'reply_now',
    description: 'Kirim satu pesan tambahan SEKARANG JUGA ke chat yang sedang berjalan, tanpa mengakhiri proses. Gunakan kalau kamu butuh kirim lebih dari 1 pesan dalam satu balasan — misalnya kasih update singkat sebelum menjalankan tool yang makan waktu lama (download, install, dsb), atau memecah jawaban panjang jadi beberapa pesan biar lebih enak dibaca. Jangan dipakai untuk pesan terakhir/penutup — teks balasan biasa di akhir sudah otomatis terkirim sebagai pesan terakhir.',
    parameters: {
        text: { type: 'string', description: 'Isi pesan yang mau dikirim sekarang', required: true }
    },
    execute: async ({ text }) => {
        const { buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        await ctx().conn.sendMessage(ctx().currentJid, { text }, ctx().currentM ? { quoted: ctx().currentM } : undefined)
        return 'Message sent'
    }
},
{
    name: 'send_rich_reply',
    description: 'Kirim balasan teks ke user, dengan sumber (kalau ada) ditampilkan sebagai tombol link di bawah pesan (native WhatsApp button, buka via in-app webview) — BUKAN link inline di teks. WAJIB dipakai sebagai balasan FINAL setelah search_web kalau ada sumber relevan — lihat rule 13. JANGAN dipakai untuk balasan biasa tanpa sumber.',
    parameters: {
        body: {
            type: 'string',
            description: 'Isi jawaban LENGKAP dalam teks natural biasa (boleh pakai *bold*/bullet "-", TAPI JANGAN tulis link/markdown [teks](url) apapun di sini -- semua link muncul terpisah sebagai tombol di bawah pesan lewat parameter citations, bukan disisipkan ke dalam teks ini).',
            required: true
        },
        citations: {
            type: 'array',
            description: 'Daftar sumber yang mau ditampilkan sebagai tombol link di bawah balasan. Tiap item: {url: "url sumber", title: "label singkat tombol, opsional -- kalau tidak diisi otomatis pakai nama domainnya, mis. \'cnnindonesia.com\'"}. Maksimal 5 tombol akan ditampilkan (kalau lebih, sisanya dipotong). Kosongkan/array kosong kalau tidak ada sumber relevan (kirim tanpa tombol).',
            required: false
        }
    },
    execute: async ({ body, citations }) => {
        const { buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!body) return 'body is required'

        const domainLabel = url => {
            try { return new URL(url).hostname.replace(/^www\./, '') } catch (_) { return null }
        }


        const seen = new Set()
        const sources = (Array.isArray(citations) ? citations : [])
            .filter(c => c?.url && !seen.has(c.url) && seen.add(c.url))
            .slice(0, 5)
            .map((c, i) => ({ url: c.url, title: (c.title || domainLabel(c.url) || `Sumber ${i + 1}`).slice(0, 24) }))

        try {
            if (sources.length) {
                await ctx().conn.sendMessage(ctx().currentJid, {
                    text: body,
                    optionText: 'source',
                    optionTitle: '\u0000',
                    nativeFlow: [
                        {},
                        ...sources.map(s => ({ text: s.title, url: s.url, useWebview: true }))
                    ]
                }, { quoted: ctx().currentM })
            } else {
                await ctx().conn.sendMessage(ctx().currentJid, { text: body }, { quoted: ctx().currentM })
            }
            return `[SUDAH TERKIRIM ke user (${sources.length} tombol sumber). JANGAN kirim teks balasan apapun lagi setelah ini -- turn selesai, cukup jawab dengan string kosong.]`
        } catch (e) {
            console.warn('[send_rich_reply] nativeFlow gagal, fallback teks biasa:', e.message)
            try {
                const fallbackLinks = sources.length
                    ? '\n\n' + sources.map(s => `• ${s.url}`).join('\n')
                    : ''
                await ctx().conn.sendMessage(ctx().currentJid, { text: body + fallbackLinks }, { quoted: ctx().currentM })
                return '[SUDAH TERKIRIM ke user (fallback teks biasa, nativeFlow gagal). JANGAN kirim teks balasan apapun lagi setelah ini -- turn selesai, cukup jawab dengan string kosong.]'
            } catch (e2) {
                console.error('[send_rich_reply] Fallback juga gagal:', e2)
                return `Gagal kirim balasan: ${e2.message}`
            }
        }
    }
}
]
