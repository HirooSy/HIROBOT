import { ctx, DOWNLOAD_PLATFORM_MAP, downloadTwitterDirect, downloadUserImageAsUrl, execPluginCommand, fetchSocialMulti } from '../mcp.js';

const DOWNLOAD_PLATFORM_KEYS = ['tiktok', 'instagram', 'youtube', 'youtube_audio', 'twitter', 'facebook']

export default [
{
    name: 'download_media',
    description: 'Download media (video/photo/audio) from supported social platforms and send it straight to the user. Choose "platform" according to the source: "tiktok" for tiktok.com/vt.tiktok.com URLs, "instagram" for instagram.com URLs (Reels/Post), "youtube" for youtube.com/youtu.be URLs when the user wants a VIDEO file, "youtube_audio" when the user asks to play a song/search for a song/download an MP3 from YouTube (a song title is enough, a URL is not required), "twitter" for twitter.com/x.com URLs, "facebook" for facebook.com URLs',
    parameters: {
        platform: {
            type: 'string',
            description: 'Media source platform: "tiktok", "facebook", "instagram", "youtube", "youtube_audio", or "twitter".',
            enum: DOWNLOAD_PLATFORM_KEYS,
            required: true
        },
        query: { type: 'string', description: 'URL of the media to download. For the "youtube_audio" platform a song title may be given when there is no URL.', required: true }
    },
    execute: async ({ platform, query }) => {
        const target = DOWNLOAD_PLATFORM_MAP[platform]
        if (!target) return `Platform "${platform}" is not recognized. Valid options: ${DOWNLOAD_PLATFORM_KEYS.join(', ')}.`

        

        

        

        
        if (platform === 'twitter') {
            try {
                return await downloadTwitterDirect(query)
            } catch (e) {
                console.error('[download_media] Gagal download twitter:', e)
                return `Failed to download Twitter/X: ${e.message}`
            }
        }

        try {
            await execPluginCommand(target.command, query)
            return `${target.label} was processed through the .${target.command} plugin, the result was sent straight to this chat.`
        } catch (e) {
            return `Failed to download ${target.label}: ${e.message}`
        }
    }
},
{
    name: 'generate_image',
    description: 'Generate images from a text description (text-to-image) using Bing Image Creator, then send them straight to the user. Each request produces 4 images that are sent together in one rich message. Use it when the user asks you to create/draw something, e.g. \"draw an astronaut cat\", \"make a picture of a mountain landscape\", \"generate image of...\". The process usually takes around 10-30 seconds, so you MUST tell the user first that this takes a few seconds before calling this tool.',
    parameters: {
        prompt: { type: 'string', description: 'The image description/prompt to generate, in English for the best result (translate it first if the user asked in another language)', required: true },
        aspect_ratio: {
            type: 'string',
            description: 'Image aspect ratio: \"1:1\" (square), \"3:2\" (landscape), or \"2:3\" (portrait). Infer it from the request if there is a clear hint, e.g. \"landscape\"/\"wide scenery\"/\"wallpaper\" -> \"3:2\", \"poster\"/\"vertical\"/\"phone wallpaper\"/\"portrait\" -> \"2:3\". If the user did not mention anything about orientation/ratio, do NOT guess, use the default \"1:1\".',
            enum: ['1:1', '3:2', '2:3'],
            required: false
        }
    },
    execute: async ({ prompt, aspect_ratio }) => {
        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        try {
            const { generateImage } = await import('../../../scrapers/src/ai-image.js')
            const imgUrls = await generateImage(prompt, { aspectRatio: aspect_ratio })
            if (!imgUrls?.length) return 'Failed to generate the image: no result from the server.'

            try {
                const rich = ctx().conn.aiRich()
                rich.addText(prompt)
                rich.addImage(imgUrls, { resolveUrl: true })
                await rich.send(ctx().currentJid, { quoted: ctx().currentM })
            } catch (richErr) {
                console.warn('[generate_image] aiRich failed, fallback sendMessage:', richErr.message)
                await ctx().conn.sendMessage(ctx().currentJid,
                    { image: { url: imgUrls[0] }, caption: prompt },
                    { quoted: ctx().currentM }
                )
            }

            return `[ALREADY SENT] ${imgUrls.length} images for \"${prompt}\" were generated successfully and have been sent.`
        } catch (e) {
            console.error('[generate_image] Failed to generate:', e)
            return `Failed to generate the image: ${e.message}`
        }
    }
},
{
    name: 'ai_edit_image',
    description: 'Edit an image the user sent/replied to using AI (image-to-image) based on a text instruction — for example "add glasses", "change it to anime style", "change the background to a beach", etc. An image MUST be attached to this message OR this message must reply to a message containing an image/sticker. The process can take a while, so tell the user first that this takes a bit before calling this tool.',
    parameters: {
        instruction: { type: 'string', description: 'The edit instruction in English for the best result (translate it first if the user asked in another language), as detailed as possible about what should change', required: true }
    },
    execute: async ({ instruction }) => {
        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!ctx().currentM) return 'There is no message context to fetch the source image from.'
        try {
            const imageUrl = await downloadUserImageAsUrl(ctx().currentM)
            if (!imageUrl) {
                return 'No image was detected — make sure the user attached an image directly or replied to a message containing an image/sticker.'
            }

            const { nanoEditImage } = await import('../../../scrapers/src/nano.js')
            const resultUrls = await nanoEditImage(imageUrl, instruction)
            if (!resultUrls?.length) {
                return 'The edit finished but no result URL could be found in the response.'
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

            return `The image was edited successfully according to the instruction "${instruction}" and has been sent to this chat.`
        } catch (e) {
            console.error('[ai_edit_image] Gagal edit:', e)
            return `Failed to edit the image: ${e.message}`
        }
    }
} 
]
