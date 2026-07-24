// ─── tools/media.js ─────────────────────────────────────────────────────────
// Kategori: download_media, generate_image, ai_edit_image, download_facebook
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'
// NOTE: DOWNLOAD_PLATFORM_MAP asli ada di mcp.js. List key di bawah ini
// SENGAJA di-hardcode (bukan Object.keys(DOWNLOAD_PLATFORM_MAP)) karena baris
// `enum:` ini dievaluasi saat modul di-load (bukan di dalam execute), padahal
// mcp.js belum tentu selesai loading di titik itu (circular-import). Kalau
// nambah/ubah platform di DOWNLOAD_PLATFORM_MAP (mcp.js), UPDATE juga list
// ini biar tetap sinkron.
const DOWNLOAD_PLATFORM_KEYS = ['tiktok', 'instagram', 'youtube', 'youtube_audio', 'twitter', 'facebook']

export default [
{
    name: 'download_media',
    description: 'Download media (video/foto/audio) dari platform sosial yang didukung dan langsung kirim ke user. Pilih "platform" sesuai sumbernya: "tiktok" untuk URL tiktok.com/vt.tiktok.com, "instagram" untuk URL instagram.com (Reels/Post), "youtube" untuk URL youtube.com/youtu.be kalau user mau file VIDEO, "youtube_audio" kalau user minta putar lagu/cari lagu/download MP3 dari YouTube (boleh cukup judul lagu, tidak wajib URL), "twitter" untuk URL twitter.com/x.com. "facebook" untuk url facebook.com',
    parameters: {
        platform: {
            type: 'string',
            description: 'Platform sumber media: "tiktok", "facebook", "instagram", "youtube", "youtube_audio", atau "twitter".',
            enum: DOWNLOAD_PLATFORM_KEYS,
            required: true
        },
        query: { type: 'string', description: 'URL media yang mau didownload. Untuk platform "youtube_audio" boleh diisi judul lagu kalau tidak ada URL.', required: true }
    },
    execute: async ({ platform, query }) => {
        const { downloadUserImageAsUrl, execPluginCommand, fetchSocialMulti, DOWNLOAD_PLATFORM_MAP } = await getMcp()

        const target = DOWNLOAD_PLATFORM_MAP[platform]
        if (!target) return `Platform "${platform}" tidak dikenali. Pilihan valid: ${DOWNLOAD_PLATFORM_KEYS.join(', ')}.`
        try {
            await execPluginCommand(target.command, query)
            return `${target.label} diproses lewat plugin .${target.command}, hasil dikirim langsung ke chat ini.`
        } catch (e) {
            return `Gagal download ${target.label}: ${e.message}`
        }
    }
},
{
    name: 'generate_image',
    description: 'Generate gambar dari deskripsi teks (text-to-image) pakai ImageGPT, lalu langsung kirim ke user. Gunakan saat user minta dibuatkan/digambarkan sesuatu, mis. "gambarin kucing astronot", "bikin gambar pemandangan gunung", "generate image of...". Proses biasanya cepat (~10-15 detik), tapi WAJIB kasih tahu user dulu bahwa ini butuh beberapa detik sebelum manggil tool ini.',
    parameters: {
        prompt: { type: 'string', description: 'Deskripsi/prompt gambar yang mau digenerate, dalam Bahasa Inggris untuk hasil terbaik (terjemahkan dulu kalau user minta pakai Bahasa Indonesia)', required: true },
        aspect_ratio: {
            type: 'string',
            description: 'Rasio aspek gambar: "1:1", "16:9", "9:16", "4:3", "3:4", atau "21:9". Infer dari konteks prompt/permintaan user kalau ada petunjuk jelas — mis. "landscape"/"pemandangan lebar"/"wallpaper" → "16:9", "poster"/"story IG"/"potret vertikal" → "9:16", "cinematic"/"sinematik" → "21:9", "foto produk"/"portrait" biasa → "4:3" atau "3:4". Kalau user tidak menyebut apapun soal orientasi/rasio, JANGAN menebak-nebak — pakai default "1:1".',
            required: false
        },
        style: {
            type: 'string',
            description: 'Gaya visual: "none" (default), "photorealistic", "cinematic", "portrait", "product", "anime", "fantasy", "3d-render", atau "vintage". Infer dari kata kunci di prompt user kalau ada — mis. "gaya anime"/"anime style" → "anime", "realistis"/"fotorealistik" → "photorealistic", "gaya kartun 3D"/"render 3D" → "3d-render", "vintage"/"jadul" → "vintage". Kalau tidak ada petunjuk gaya di prompt, pakai default "none".',
            required: false
        }
    },
    execute: async ({ prompt, aspect_ratio, style }) => {
        const { downloadUserImageAsUrl, execPluginCommand, fetchSocialMulti } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        try {
            const { generateImage } = await import('../../scraper/ai-image.js')
            const imgUrls = await generateImage(prompt, { aspectRatio: aspect_ratio, style })
            if (!imgUrls.length) return 'Gagal generate gambar: tidak ada hasil dari server.'

            try {
                await ctx().conn.sendFile(ctx().currentJid, imgUrls[0], 'ai-image.png', prompt, ctx().currentM)
            } catch (sendErr) {
                console.warn('[generate_image] sendFile gagal, fallback aiRich:', sendErr.message)
                try {
                    const rich = ctx().conn.aiRich()
                    rich.addText(prompt)
                    rich.addImage(imgUrls)
                    await rich.send(ctx().currentJid, { quoted: ctx().currentM })
                } catch (richErr) {
                    console.warn('[generate_image] aiRich juga gagal, fallback sendMessage:', richErr.message)
                    await ctx().conn.sendMessage(ctx().currentJid, { image: { url: imgUrls[0] }, caption: prompt }, { quoted: ctx().currentM })
                }
            }

            return `Gambar berhasil digenerate dari prompt "${prompt}" dan sudah dikirim ke chat ini.`
        } catch (e) {
            console.error('[generate_image] Gagal generate:', e)
            return `Gagal generate gambar: ${e.message}`
        }
    }
},
{
    name: 'ai_edit_image',
    description: 'Edit gambar yang dikirim/di-reply user pakai AI (image-to-image) berdasarkan instruksi teks — misalnya "tambahin kacamata", "ubah jadi gaya anime", "ganti background jadi pantai", dsb. WAJIB ada gambar terlampir di pesan ini ATAU pesan ini me-reply pesan yang berisi gambar/stiker. Proses bisa makan waktu, jadi kasih tahu user dulu bahwa ini agak lama sebelum manggil tool ini.',
    parameters: {
        instruction: { type: 'string', description: 'Instruksi edit dalam Bahasa Inggris untuk hasil terbaik (terjemahkan dulu kalau user minta pakai Bahasa Indonesia), sedetail mungkin soal apa yang diubah', required: true }
    },
    execute: async ({ instruction }) => {
        const { downloadUserImageAsUrl, execPluginCommand, fetchSocialMulti } = await getMcp()

        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!ctx().currentM) return 'Tidak ada konteks pesan untuk ambil gambar sumber.'
        try {
            const imageUrl = await downloadUserImageAsUrl(ctx().currentM)
            if (!imageUrl) {
                return 'Tidak ada gambar yang terdeteksi — pastikan user melampirkan gambar langsung atau me-reply pesan yang berisi gambar/stiker.'
            }

            const { nanoEditImage } = await import('../../scraper/nano.js')
            const resultUrls = await nanoEditImage(imageUrl, instruction)
            if (!resultUrls?.length) {
                return 'Edit selesai tapi tidak ada URL hasil yang bisa ditemukan di response.'
            }

            try {
                await ctx().conn.sendFile(ctx().currentJid, resultUrls[0], 'nano.png', instruction, ctx().currentM)
            } catch (sendErr) {
                console.warn('[ai_edit_image] sendFile gagal, fallback aiRich:', sendErr.message)
                try {
                    const rich = ctx().conn.aiRich()
                    rich.addText(instruction)
                    rich.addImage(resultUrls)
                    await rich.send(ctx().currentJid, { quoted: ctx().currentM })
                } catch (richErr) {
                    console.warn('[ai_edit_image] aiRich juga gagal, fallback sendMessage:', richErr.message)
                    await ctx().conn.sendMessage(ctx().currentJid, { image: { url: resultUrls[0] }, caption: instruction }, { quoted: ctx().currentM })
                }
            }

            return `Gambar berhasil diedit sesuai instruksi "${instruction}" dan sudah dikirim ke chat ini.`
        } catch (e) {
            console.error('[ai_edit_image] Gagal edit:', e)
            return `Gagal edit gambar: ${e.message}`
        }
    }
} 
]
