import {
    prepareWAMessageMedia,
    generateWAMessageFromContent
} from 'baileys'
import fetch from 'node-fetch'

const isImageMsg = (msg) =>
    msg?.mtype === 'imageMessage' ||
    msg?.message?.imageMessage != null ||
    msg?.msg?.mimetype?.includes('image')

const isVideoMsg = (msg) =>
    msg?.mtype === 'videoMessage' ||
    msg?.message?.videoMessage != null ||
    msg?.msg?.mimetype?.includes('video')

let handler = async (m, { conn, text, usedPrefix, command }) => {
    let img   = null
    let video = null

    const args = text?.trim().split(/\s+/) || []
    const urlPattern = /https?:\/\/\S+/gi

    // ─────────────────────────────────────────────────────────────
    // MODE 1: /imgmotion <imgurl> <videourl>
    // ─────────────────────────────────────────────────────────────
    if (args.length >= 2 && urlPattern.test(args[0])) {
        const imgUrl   = args[0]
        const videoUrl = args[1]

        await m.react('⏳')
        try {
            img   = await (await fetch(imgUrl)).buffer()
            video = await (await fetch(videoUrl)).buffer()
        } catch (e) {
            return m.reply(`> Failed to download from URL.\n\`\`\`${e.message}\`\`\``)
        }

        return await sendMotion(conn, m, img, video)
    }

    // ─────────────────────────────────────────────────────────────
    // Ambil gambar & video dari pesan saat ini atau quoted
    // ─────────────────────────────────────────────────────────────
    if (isImageMsg(m))               img   = await m.download()
    else if (isImageMsg(m.quoted))   img   = await m.quoted.download()

    if (isVideoMsg(m))               video = await m.download()
    else if (isVideoMsg(m.quoted))   video = await m.quoted.download()

    // Dapat keduanya sekaligus → langsung proses
    if (img && video) {
        await m.react('⏳')
        return await sendMotion(conn, m, img, video)
    }

    // ─────────────────────────────────────────────────────────────
    // Step by step — simpan dulu, tunggu yang kurang
    // ─────────────────────────────────────────────────────────────
    if (!img && !video) {
        return m.reply(
            `> *Usage:*\n` +
            `1. Send/reply *image* with caption \`${usedPrefix + command}\`\n` +
            `2. Then send *video* with caption \`2\`\n` +
            `3. Or reply *image + video* together\n` +
            `4. Or: \`${usedPrefix + command} <imgUrl> <videoUrl>\``
        )
    }

    conn.imgmotion = conn.imgmotion || {}

    if (img && !video) {
        await m.react('⏳')
        conn.imgmotion[m.sender] = {
            img,
            chat: m.chat,
            timeout: setTimeout(() => delete conn.imgmotion[m.sender], 120000)
        }
        return await conn.reply(m.chat, `✅ Image received!\n\nNow send a *video* with caption \`2\` to create Motion Image.`, m)
    }

    if (!img && video) {
        await m.react('⏳')
        conn.imgmotion[m.sender] = {
            video,
            chat: m.chat,
            timeout: setTimeout(() => delete conn.imgmotion[m.sender], 120000)
        }
        return await conn.reply(m.chat, `✅ Video received!\n\nNow send an *image* with caption \`2\` to create Motion Image.`, m)
    }
}

handler.before = async (m, { conn }) => {
    conn.imgmotion = conn.imgmotion || {}
    if (!(m.sender in conn.imgmotion)) return

    const state = conn.imgmotion[m.sender]
    let img     = state.img   || null
    let video   = state.video || null

    // ─────────────────────────────────────────────────────────────
    // Cek apakah pesan saat ini adalah media yang dibutuhkan
    // User bisa kirim video/image dengan caption "2" atau apapun
    // ATAU reply media + ketik "2"
    // ─────────────────────────────────────────────────────────────
    const input = m.text?.trim()

    // Ambil dari pesan saat ini
    if (!img && isImageMsg(m))     img   = await m.download()
    if (!video && isVideoMsg(m))   video = await m.download()

    // Ambil dari quoted jika ada
    if (!img && isImageMsg(m.quoted))   img   = await m.quoted.download()
    if (!video && isVideoMsg(m.quoted)) video = await m.quoted.download()

    // Belum dapat keduanya — update state dan tunggu lagi
    if (img && !video) {
        state.img = img
        // Hanya beri notif kalau user ketik 2
        if (input === '2') await conn.reply(m.chat, `> Please also send a *video* with caption \`2\`.`, m)
        return
    }

    if (!img && video) {
        state.video = video
        if (input === '2') await conn.reply(m.chat, `> Please also send an *image* with caption \`2\`.`, m)
        return
    }

    // Tidak ada media sama sekali — abaikan
    if (!img && !video) return

    // Punya keduanya → proses
    clearTimeout(state.timeout)
    delete conn.imgmotion[m.sender]

    await m.react('⏳')
    await sendMotion(conn, m, img, video)
}

// ─────────────────────────────────────────────────────────────
// CORE: Upload & kirim Motion Image
// ─────────────────────────────────────────────────────────────
async function sendMotion(conn, m, img, video) {
    try {
        const imageMedia = await prepareWAMessageMedia(
            { image: img },
            { upload: conn.waUploadToServer }
        )

        const videoMedia = await prepareWAMessageMedia(
            { video: video },
            { upload: conn.waUploadToServer }
        )

        const msg = generateWAMessageFromContent(
            m.chat,
            {
                imageMessage: {
                    ...imageMedia.imageMessage,
                    caption: '',
                    contextInfo: {
                        pairedMediaType: 5,
                        statusSourceType: 0
                    }
                }
            },
            {}
        )

        await conn.relayMessage(m.chat, msg.message, {
            messageId: msg.key.id
        })

        await conn.relayMessage(
            m.chat,
            {
                videoMessage: {
                    ...videoMedia.videoMessage,
                    caption: '',
                    contextInfo: {
                        pairedMediaType: 6,
                        statusSourceType: 0
                    }
                },
                messageContextInfo: {
                    messageAssociation: {
                        associationType: 12,
                        parentMessageKey: msg.key
                    }
                }
            },
            {}
        )

        await m.react('✅')
    } catch (e) {
        console.error(e)
        m.error = e
        await m.react('❌')
        await conn.reply(m.chat, `> *(;ŏ﹏ŏ) Ops! Something went wrong.*\n\n\`\`\`${e.message}\`\`\``, m)
    }
}

handler.help = ['imgmotion']
handler.tags = ['tools']
handler.command = /^imgmotion$/i
handler.limit = true

export default handler