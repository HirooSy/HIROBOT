// Sprem 
// note sesuain sama sc kalian

import { prepareWAMessageMedia } from 'baileys'

const handler = async (m, { conn }) => {
    const q = m.quoted

    if (!q || q.mtype !== 'stickerMessage') {
        throw 'Reply stiker yang ingin dijadikan AI + Premium sticker'
    }

    const sticker = await q.download()

    const media = await prepareWAMessageMedia(
        { sticker },
        { upload: conn.waUploadToServer }
    )

    delete media.stickerMessage.contextInfo

    await conn.relayMessage(
        m.chat,
        {
            stickerMessage: {
                ...media.stickerMessage,
                premium: 1,
                isAiSticker: true
            }
        },
        {
            messageId: conn.generateMessageTag()
        }
    )
}

handler.help = handler.dym = ['sprem']
handler.tags = ['sticker']
handler.command = /^(sprem)$/i

export default handler