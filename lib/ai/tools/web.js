// ─── tools/web.js ─────────────────────────────────────────────────────────
// Kategori: view_website, fetch_html_raw, view_link_post, search_web
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'
import fs from 'fs'
import { GoogleGenAI } from '@google/genai'

export default [
{
    name: 'view_website',
    description: 'Ambil screenshot full-page desktop dari sebuah website UMUM (bukan TikTok/Instagram/YouTube/Twitter-X) lalu analisa isinya secara visual menggunakan Gemini Vision. Gunakan tool ini kalau user minta cek isi website/link post di LUAR keempat platform sosmed itu (mis. e621, artstation, blog, toko online, github, dst) — untuk lihat tampilan halaman atau ingin AI tahu apa yang ada di suatu URL. Screenshot diambil dari screenshotmachine.com (full-page, mode desktop). Hasil: AI akan mendeskripsikan/menganalisa isi visual halaman tersebut. JANGAN pakai tool ini untuk URL TikTok/Instagram/YouTube/Twitter — untuk itu pakai view_link_post (visualnya lebih akurat karena ambil media asli dari scraper platform, bukan screenshot browser generik).',
    parameters: {
        url:   { type: 'string', description: 'URL website yang ingin di-screenshot dan dianalisa. Harus dimulai dengan http:// atau https://', required: true },
        focus: { type: 'string', description: 'Apa yang ingin diketahui dari website ini? (opsional, contoh: "cek harga produk", "lihat konten utama", "baca teks yang ada")', required: false }
    },
    execute: async ({ url, focus }) => {
        const { MODELS, captureWebsiteScreenshot, detectPlatform, fetchWebsiteHtmlFallback, getNextKey, getPersonality, peekAnalyzeWithVision, peekFetchBuffer, peekFetchVideoBuffer, searchWebGrounded } = await getMcp()


        let targetUrl = url.trim()
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`
        }

        let imgBuffer = null
        let screenshotErr = null
        try {
            imgBuffer = await captureWebsiteScreenshot(targetUrl)
        } catch (err) {
            screenshotErr = err
            console.warn(`[view_website] Screenshot gagal untuk "${targetUrl}", fallback ke HTML mentah:`, err.message)
        }





        const apiKey = getNextKey()
        if (!apiKey) return 'Tidak ada API key Gemini tersedia untuk analisa.'
        const { GoogleGenAI } = await import('@google/genai')
        const ai = new GoogleGenAI({ apiKey })

        let visionRes
        let usedFallback = false

        if (imgBuffer) {

            const base64 = imgBuffer.toString('base64')
            const mimeType = 'image/jpeg'
            const prompt = focus
                ? `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai untuk balasan ini — jangan jawab dengan format laporan/heading formal (jangan pakai heading markdown ###, jangan bullet-point terstruktur berlebihan), cukup teks natural mengalir seperti chatting.\n\nIni adalah screenshot full-page dari website: ${targetUrl}\n\nTolong analisa gambar ini dan jawab: ${focus}\n\nBerikan informasi selengkap mungkin berdasarkan apa yang terlihat di screenshot, tapi tetap dengan gaya natural di atas.`
                : `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai untuk balasan ini — jangan jawab dengan format laporan/heading formal (jangan pakai heading markdown ###, jangan bullet-point terstruktur berlebihan), cukup teks natural mengalir seperti chatting.\n\nIni adalah screenshot full-page dari website: ${targetUrl}\n\nTolong deskripsikan dan ringkas isi website ini: judul, konten utama, menu/navigasi, informasi penting yang terlihat, dll — tapi sampaikan dengan natural, bukan format laporan.`
            try {
                visionRes = await ai.models.generateContent({
                    model: MODELS.default,
                    contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType, data: base64 } },
                            { text: prompt }
                        ]
                    }]
                })
            } catch (err) {
                return `Screenshot berhasil diambil, tapi Gemini gagal menganalisa: ${err.message}`
            }
        } else {


            usedFallback = true
            let html
            try {
                html = await fetchWebsiteHtmlFallback(targetUrl)
            } catch (htmlErr) {
                return `Gagal ambil isi "${targetUrl}" — screenshot gagal (${screenshotErr?.message || 'unknown'}) DAN fallback ambil HTML mentah juga gagal (${htmlErr.message}). Situsnya kemungkinan down/memblokir akses otomatis.`
            }
            const prompt = focus
                ? `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai — jangan format laporan/heading formal, cukup teks natural mengalir.\n\nScreenshot visual website ${targetUrl} gagal diambil, tapi ini HTML mentah halamannya (tag script/style sudah dibuang). Tolong baca dan jawab: ${focus}\n\nHTML:\n${html}`
                : `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai — jangan format laporan/heading formal, cukup teks natural mengalir.\n\nScreenshot visual website ${targetUrl} gagal diambil, tapi ini HTML mentah halamannya (tag script/style sudah dibuang). Tolong deskripsikan dan ringkas isi website ini: judul, konten utama, informasi penting yang ada di teks/markup-nya — sampaikan natural, bukan format laporan.\n\nHTML:\n${html}`
            try {
                visionRes = await ai.models.generateContent({
                    model: MODELS.default,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                })
            } catch (err) {
                return `Screenshot gagal (${screenshotErr?.message || 'unknown'}), dan Gemini juga gagal menganalisa HTML fallback-nya: ${err.message}`
            }
        }

        const analysisText = visionRes?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('\n')
            ?.trim() || 'Tidak dapat menganalisa halaman ini.'
        const note = usedFallback ? '\n\n_(catatan: screenshot visual gagal diambil, analisa ini berdasarkan HTML mentah halaman, bukan tampilan visual)_' : ''
        return `*Analisa website: ${targetUrl}*\n\n${analysisText}${note}`
    }
},
{
    name: 'fetch_html_raw',
    description: 'Ambil HTML mentah dari sebuah URL secara langsung (bukan screenshot/visual) lalu ringkas isinya lewat Gemini sebagai teks. Gunakan tool ini SPESIFIK ketika user secara eksplisit minta "html", "source code halaman", "cek isi mentahnya", atau ingin tahu isi teks/markup suatu halaman tanpa perlu tampilan visualnya. Beda dari view_website yang fokus ke tampilan visual — tool ini murni membaca teks/HTML.',
    parameters: {
        url:   { type: 'string', description: 'URL yang HTML-nya ingin diambil. Harus dimulai dengan http:// atau https://', required: true },
        focus: { type: 'string', description: 'Apa yang ingin diketahui dari HTML ini? (opsional)', required: false }
    },
    execute: async ({ url, focus }) => {
        const { MODELS, captureWebsiteScreenshot, detectPlatform, fetchWebsiteHtmlFallback, getNextKey, getPersonality, peekAnalyzeWithVision, peekFetchBuffer, peekFetchVideoBuffer, searchWebGrounded } = await getMcp()

        let targetUrl = url.trim()
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`
        }
        let html
        try {
            html = await fetchWebsiteHtmlFallback(targetUrl)
        } catch (err) {
            return `Gagal ambil HTML dari "${targetUrl}": ${err.message}`
        }
        const apiKey = getNextKey()
        if (!apiKey) return 'Tidak ada API key Gemini tersedia untuk analisa.'
        const { GoogleGenAI } = await import('@google/genai')
        const ai = new GoogleGenAI({ apiKey })
        const prompt = focus
            ? `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai — jangan format laporan/heading formal (jangan pakai ### atau bullet terstruktur berlebihan), cukup teks natural mengalir seperti chatting.\n\nIni HTML mentah dari halaman ${targetUrl} (tag script/style sudah dibuang). Tolong jawab: ${focus}\n\nHTML:\n${html}`
            : `${getPersonality()}\n\nGaya bicara di atas WAJIB kamu pakai — jangan format laporan/heading formal (jangan pakai ### atau bullet terstruktur berlebihan), cukup teks natural mengalir seperti chatting.\n\nIni HTML mentah dari halaman ${targetUrl} (tag script/style sudah dibuang). Tolong ringkas isi halaman ini: judul, konten utama, struktur/elemen penting — sampaikan dengan natural, bukan format laporan.\n\nHTML:\n${html}`
        let visionRes
        try {
            visionRes = await ai.models.generateContent({
                model: MODELS.default,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            })
        } catch (err) {
            return `HTML berhasil diambil, tapi Gemini gagal menganalisa: ${err.message}`
        }
        const analysisText = visionRes?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('\n')
            ?.trim() || 'Tidak dapat menganalisa HTML ini.'
        return `*HTML mentah dari: ${targetUrl}*\n\n${analysisText}`
    }
},
{
    name: 'view_link_post',
    description: 'Lihat isi konten VISUAL dari link TikTok / Instagram / YouTube / Twitter-X SPESIFIK — ambil media asli (foto/thumbnail/cover) langsung dari scraper platform masing-masing (BUKAN screenshot browser), lalu AI bereaksi/berkomentar tentang isinya. WAJIB PAKAI TOOL INI (bukan view_website) untuk keempat platform ini, karena visualnya jauh lebih akurat (media asli, bukan tangkapan layar halaman). Gunakan ketika user share link salah satu dari 4 platform itu dan TIDAK minta download, tapi ingin AI tahu/berkomentar isi post tersebut. Contoh trigger: "cek ini", "lihat dong", "gimana menurut lo", "react dong ke ini", atau user kirim link tanpa instruksi download.',
    parameters: {
        url:     { type: 'string', description: 'URL post (TikTok, Instagram, YouTube, Twitter/X)', required: true },
        context: { type: 'string', description: 'Konteks atau pertanyaan spesifik user tentang konten ini (opsional)', required: false }
    },
    execute: async ({ url, context = '' }) => {
        const { MODELS, captureWebsiteScreenshot, detectPlatform, fetchWebsiteHtmlFallback, getNextKey, getPersonality, peekAnalyzeWithVision, peekFetchBuffer, peekFetchVideoBuffer, searchWebGrounded } = await getMcp()

        const platform = detectPlatform(url)
        const mediaItems = []

        try {
            if (platform === 'tiktok') {
                const { tiktok } = await import('../../scraper/tiktok.js')
                const data = await tiktok(url)
                if (data.images?.length) {

                    const { buffer, contentType } = await peekFetchBuffer(data.images[0])
                    mediaItems.push({ buffer, contentType })
                } else if (data.play) {

                    mediaItems.push({ buffer: Buffer.alloc(0), contentType: 'video/mp4', thumbnailUrl: data.cover || data.origin_cover || null })
                }
            } else if (platform === 'instagram') {
                const { instagram } = await import('../../scraper/ig.js')
                const result = await instagram(url)
                if (result.status && result.result) {
                    const { metadata, media } = result.result

                    if (metadata?.type === 'single_image') {
                        const imgUrl = media.images?.[0]?.url
                        if (imgUrl) {
                            const { buffer, contentType } = await peekFetchBuffer(imgUrl)
                            mediaItems.push({ buffer, contentType })
                        }
                    } else if (metadata?.type === 'video' || metadata?.type === 'reels') {
                        const vidUrl = media.videos?.[0]?.url
                        let sentVideo = false
                        if (vidUrl) {
                            try {
                                const MAX_VIDEO_BYTES = 15 * 1024 * 1024
                                const { buffer, contentType, tooLarge } = await peekFetchVideoBuffer(vidUrl, MAX_VIDEO_BYTES)
                                if (!tooLarge && buffer.length > 0) {
                                    mediaItems.push({ buffer, contentType: contentType.includes('mp4') ? contentType : 'video/mp4' })
                                    sentVideo = true
                                }
                            } catch (err) {
                                console.warn('[view_link_post] Gagal download video IG utuh, fallback ke thumbnail:', err.message)
                            }
                        }



                        if (!sentVideo && media.thumbnail) {
                            try {
                                const buffer = fs.readFileSync(media.thumbnail)
                                mediaItems.push({ buffer, contentType: 'image/jpeg' })
                            } catch (_) {}
                        }
                        if (media.thumbnail) {
                            try { fs.unlinkSync(media.thumbnail) } catch (_) {}
                        }
                    } else if (metadata?.type === 'carousel') {
                        const first = media.items?.[0]
                        let sentVideo = false
                        if (first?.type === 'video') {
                            const vidUrl = first.videos?.[0]?.url
                            if (vidUrl) {
                                try {
                                    const MAX_VIDEO_BYTES = 15 * 1024 * 1024
                                    const { buffer, contentType, tooLarge } = await peekFetchVideoBuffer(vidUrl, MAX_VIDEO_BYTES)
                                    if (!tooLarge && buffer.length > 0) {
                                        mediaItems.push({ buffer, contentType: contentType.includes('mp4') ? contentType : 'video/mp4' })
                                        sentVideo = true
                                    }
                                } catch (err) {
                                    console.warn('[view_link_post] Gagal download video carousel utuh, fallback ke thumbnail:', err.message)
                                }
                            }
                        }
                        if (!sentVideo && media.thumbnail) {
                            try {
                                if (/^https?:\/\//.test(media.thumbnail)) {
                                    const { buffer, contentType } = await peekFetchBuffer(media.thumbnail)
                                    mediaItems.push({ buffer, contentType })
                                } else {
                                    const buffer = fs.readFileSync(media.thumbnail)
                                    mediaItems.push({ buffer, contentType: 'image/jpeg' })
                                }
                            } catch (_) {}
                        }
                        if (media.thumbnail && !/^https?:\/\//.test(media.thumbnail)) {
                            try { fs.unlinkSync(media.thumbnail) } catch (_) {}
                        }
                        if (media.items?.length > 1) {
                            context = [`(Carousel berisi ${media.items.length} slide, ini slide pertama saja)`, context].filter(Boolean).join(' — ')
                        }
                    } else if (media.thumbnail) {

                        try {
                            if (/^https?:\/\//.test(media.thumbnail)) {
                                const { buffer, contentType } = await peekFetchBuffer(media.thumbnail)
                                mediaItems.push({ buffer, contentType })
                            } else {
                                const buffer = fs.readFileSync(media.thumbnail)
                                mediaItems.push({ buffer, contentType: 'image/jpeg' })
                                try { fs.unlinkSync(media.thumbnail) } catch (_) {}
                            }
                        } catch (_) {}
                    }
                }
            } else if (platform === 'youtube') {

                const videoIdMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/)|[?&]v=)([a-zA-Z0-9-_]{11})/)
                const videoId = videoIdMatch?.[1]
                if (videoId) {
                    const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
                    const { buffer, contentType } = await peekFetchBuffer(thumbUrl)
                    mediaItems.push({ buffer, contentType })
                }
            } else if (platform === 'twitter') {
                const { twitter } = await import('../../scraper/x.js')
                const data = await twitter(url)

                if (data.thumbnail) {
                    try {
                        const { buffer, contentType } = await peekFetchBuffer(data.thumbnail)
                        mediaItems.push({ buffer, contentType })
                    } catch (_) {}
                }

                if (data.description) context = [data.description, context].filter(Boolean).join(' — ')
            } else {

                return `Platform tidak dikenal untuk peek. Coba gunakan view_website untuk melihat isi URL ini.`
            }
        } catch (err) {
            console.warn(`[view_link_post] Gagal ambil media dari ${platform}:`, err.message)
            const isModuleErr = err.message.includes("does not provide") || err.message.includes("Cannot find module")
            if (isModuleErr) {
                return `[view_link_post ERROR INTERNAL — scraper module tidak ditemukan: ${err.message}. Ini bug kode, bukan kuota habis. Jangan bilang kuota habis ke user — bilang fitur peek sedang ada gangguan teknis, tawarkan download biasa sebagai alternatif.]`
            }
            return `[view_link_post GAGAL — ${err.message}. Tawarkan alternatif ke user seperti download biasa, jangan bilang "kuota habis".]`
        }

        return await peekAnalyzeWithVision(mediaItems, platform, url, context)
    }
},
{
    name: 'search_web',
    description: 'Cari informasi terbaru dari internet (Gemini native grounding via Google Search — model gemini-3.1-flash-lite, fallback ke gemini-2.5-flash kalau gagal/limit). Pakai untuk berita, harga, data real-time, atau hal yang mungkin sudah berubah sejak training. PENTING: setelah dapat hasil dari tool ini, balasan akhirmu ke user WAJIB lewat tool send_rich_reply (lihat rule 13) — JANGAN PERNAH langsung menjawab dengan teks biasa yang menempel link mentah dari bagian "Sumber:" hasil tool ini.',
    parameters: {
        query: { type: 'string', description: 'Kata kunci atau pertanyaan yang ingin dicari', required: true }
    },
    execute: async ({ query }) => {
        const { MODELS, captureWebsiteScreenshot, detectPlatform, fetchWebsiteHtmlFallback, getNextKey, getPersonality, peekAnalyzeWithVision, peekFetchBuffer, peekFetchVideoBuffer, searchWebGrounded } = await getMcp()

        try {
            const result = await searchWebGrounded(query)
            if (!result?.answer) {
                return 'Search tidak mengembalikan jawaban untuk query ini. Jawab dari pengetahuanmu dan tandai bahwa info mungkin tidak terkini.'
            }




            const sources = (result.sources || [])
                .map(s => `• ${s.title}: ${s.url}`)
                .join('\n')
            const reminder = '\n\n[INSTRUKSI WAJIB: JANGAN jawab langsung ke user pakai teks biasa. Panggil tool send_rich_reply sekarang — body = rangkuman di atas dalam bahasa natural TANPA link apapun, citations = daftar {url, title} dari sumber di atas yang relevan (akan muncul sebagai tombol link di bawah pesan).]'
            return result.answer + (sources ? `\n\nDaftar sumber (untuk dipasangkan via send_rich_reply, JANGAN ditempel mentah):\n${sources}` : '') + reminder
        } catch (e) {
            console.warn(`[search_web] Error: ${e.message}`)
            return `Search gagal: ${e.message}. Jawab dari pengetahuanmu dan tandai bahwa info mungkin tidak terkini.`
        }
    }
}
]
