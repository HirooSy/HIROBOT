import { ctx, MODELS, captureWebsiteScreenshot, createGeminiClient, detectPlatform, fetchWebsiteHtmlFallback, getNextKey, getPersonality, peekAnalyzeWithVision, peekFetchBuffer, peekFetchVideoBuffer, searchWebGrounded } from '../mcp.js';
import fs from 'fs'

export default [
{
    name: 'view_website',
    description: 'Take a full-page desktop screenshot of a GENERAL website (not TikTok/Instagram/YouTube/Twitter-X) and analyze its content visually using Gemini Vision. Use this tool when the user asks to check the content of a website/link post OUTSIDE those four social platforms (e.g. e621, artstation, a blog, an online shop, github, etc) — to see how a page looks or to let the AI know what is at a URL. The screenshot is taken from screenshotmachine.com (full-page, desktop mode). Result: the AI will describe/analyze the visual content of that page. Do NOT use this tool for TikTok/Instagram/YouTube/Twitter URLs — use view_link_post for those (its visuals are more accurate because it fetches the original media from the platform scraper, not a generic browser screenshot).',
    parameters: {
        url: { type: 'string', description: 'The website URL to screenshot and analyze. Must start with http:// or https://', required: true },
        focus: { type: 'string', description: 'What do you want to know about this website? (optional, e.g. "check the product price", "see the main content", "read the text on it")', required: false }
    },
    execute: async ({ url, focus }) => {
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
        if (!apiKey) return 'No Gemini API key available for analysis.'
        const ai = createGeminiClient({ apiKey })

        let visionRes
        let usedFallback = false

        if (imgBuffer) {

            const base64 = imgBuffer.toString('base64')
            const mimeType = 'image/jpeg'
            const prompt = focus
                ? `${getPersonality()}\n\nYou MUST use the speaking style above for this reply — do not answer in a report format/formal headings (no markdown ### headings, no excessive structured bullet points), just natural flowing text like chatting.\n\nThis is a full-page screenshot of the website: ${targetUrl}\n\nPlease analyze this image and answer: ${focus}\n\nGive information as complete as possible based on what is visible in the screenshot, but still in the natural style above.`
                : `${getPersonality()}\n\nYou MUST use the speaking style above for this reply — do not answer in a report format/formal headings (no markdown ### headings, no excessive structured bullet points), just natural flowing text like chatting.\n\nThis is a full-page screenshot of the website: ${targetUrl}\n\nPlease describe and summarize the content of this website: title, main content, menu/navigation, visible important information, etc — but deliver it naturally, not in a report format.`
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
                return `The screenshot was taken, but Gemini failed to analyze it: ${err.message}`
            }
        } else {

            usedFallback = true
            let html
            try {
                html = await fetchWebsiteHtmlFallback(targetUrl)
            } catch (htmlErr) {
                return `Failed to get the content of "${targetUrl}" — the screenshot failed (${screenshotErr?.message || 'unknown'}) AND the fallback of fetching the raw HTML also failed (${htmlErr.message}). The site is probably down/blocking automated access.`
            }
            const prompt = focus
                ? `${getPersonality()}\n\nYou MUST use the speaking style above — no report format/formal headings, just natural flowing text.\n\nThe visual screenshot of the website ${targetUrl} failed to be taken, but here is the raw HTML of the page (script/style tags removed). Please read it and answer: ${focus}\n\nHTML:\n${html}`
                : `${getPersonality()}\n\nYou MUST use the speaking style above — no report format/formal headings, just natural flowing text.\n\nThe visual screenshot of the website ${targetUrl} failed to be taken, but here is the raw HTML of the page (script/style tags removed). Please describe and summarize the content of this website: title, main content, important information in its text/markup — deliver it naturally, not in a report format.\n\nHTML:\n${html}`
            try {
                visionRes = await ai.models.generateContent({
                    model: MODELS.default,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                })
            } catch (err) {
                return `The screenshot failed (${screenshotErr?.message || 'unknown'}), and Gemini also failed to analyze its fallback HTML: ${err.message}`
            }
        }

        const analysisText = visionRes?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('\n')
            ?.trim() || 'Could not analyze this page.'
        const note = usedFallback ? '\n\n_(note: the visual screenshot failed to be taken, this analysis is based on the raw HTML of the page, not the visual appearance)_' : ''
        return `*Analisa website: ${targetUrl}*\n\n${analysisText}${note}`
    }
},
{
    name: 'fetch_html_raw',
    description: 'Fetch the raw HTML from a URL directly (not a screenshot/visual) and summarize its content through Gemini as text. Use this tool SPECIFICALLY when the user explicitly asks for "html", "the page source code", "check its raw content", or wants to know the text/markup content of a page without needing its visual appearance. Different from view_website, which focuses on the visual appearance — this tool purely reads text/HTML.',
    parameters: {
        url: { type: 'string', description: 'The URL whose HTML should be fetched. Must start with http:// or https://', required: true },
        focus: { type: 'string', description: 'What do you want to know from this HTML? (optional)', required: false }
    },
    execute: async ({ url, focus }) => {
        let targetUrl = url.trim()
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`
        }
        let html
        try {
            html = await fetchWebsiteHtmlFallback(targetUrl)
        } catch (err) {
            return `Failed to fetch the HTML from "${targetUrl}": ${err.message}`
        }
        const apiKey = getNextKey()
        if (!apiKey) return 'No Gemini API key available for analysis.'
        const ai = createGeminiClient({ apiKey })
        const prompt = focus
            ? `${getPersonality()}\n\nYou MUST use the speaking style above — no report format/formal headings (no ### or excessive structured bullets), just natural flowing text like chatting.\n\nThis is the raw HTML of the page ${targetUrl} (script/style tags removed). Please answer: ${focus}\n\nHTML:\n${html}`
            : `${getPersonality()}\n\nYou MUST use the speaking style above — no report format/formal headings (no ### or excessive structured bullets), just natural flowing text like chatting.\n\nThis is the raw HTML of the page ${targetUrl} (script/style tags removed). Please summarize the content of this page: title, main content, important structure/elements — deliver it naturally, not in a report format.\n\nHTML:\n${html}`
        let visionRes
        try {
            visionRes = await ai.models.generateContent({
                model: MODELS.default,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            })
        } catch (err) {
            return `The HTML was fetched, but Gemini failed to analyze it: ${err.message}`
        }
        const analysisText = visionRes?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('\n')
            ?.trim() || 'Could not analyze this HTML.'
        return `*Raw HTML from: ${targetUrl}*\n\n${analysisText}`
    }
},
{
    name: 'view_link_post',
    description: 'See the VISUAL content of a SPECIFIC TikTok / Instagram / YouTube / Twitter-X link — fetch the original media (photo/thumbnail/cover) directly from each platform\'s scraper (NOT a browser screenshot), then the AI reacts/comments on its content. YOU MUST USE THIS TOOL (not view_website) for these four platforms, because its visuals are far more accurate (original media, not a screenshot of the page). Use it when the user shares a link from one of those 4 platforms and does NOT ask to download, but wants the AI to know about/comment on that post. Example triggers: "check this", "take a look", "what do you think", "react to this", or the user sends a link without a download instruction.',
    parameters: {
        url: { type: 'string', description: 'URL post (TikTok, Instagram, YouTube, Twitter/X)', required: true },
        context: { type: 'string', description: 'The user\'s specific context or question about this content (optional)', required: false }
    },
    execute: async ({ url, context = '' }) => {
        const platform = detectPlatform(url)
        const mediaItems = []

        try {
            if (platform === 'tiktok') {
                const { tiktok } = await import('../../../scrapers/src/tiktok.js')
                const data = await tiktok(url)
                if (data.images?.length) {

                    const { buffer, contentType } = await peekFetchBuffer(data.images[0])
                    mediaItems.push({ buffer, contentType })
                } else if (data.play) {

                    mediaItems.push({ buffer: Buffer.alloc(0), contentType: 'video/mp4', thumbnailUrl: data.cover || data.origin_cover || null })
                }
            } else if (platform === 'instagram') {
                const { instagram } = await import('../../../scrapers/src/ig.js')
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
                            context = [`(Carousel with ${media.items.length} slides, this is only the first slide)`, context].filter(Boolean).join(' — ')
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
                const { twitter } = await import('../../../scrapers/src/x.js')
                const data = await twitter(url)

                if (data.thumbnail) {
                    try {
                        const { buffer, contentType } = await peekFetchBuffer(data.thumbnail)
                        mediaItems.push({ buffer, contentType })
                    } catch (_) {}
                }

                if (data.description) context = [data.description, context].filter(Boolean).join(' — ')
            } else {

                return `Unknown platform for peek. Try using view_website to see the content of this URL.`
            }
        } catch (err) {
            console.warn(`[view_link_post] Gagal ambil media dari ${platform}:`, err.message)
            const isModuleErr = err.message.includes("does not provide") || err.message.includes("Cannot find module")
            if (isModuleErr) {
                return `[view_link_post INTERNAL ERROR — scraper module not found: ${err.message}. This is a code bug, not an exhausted quota. Do not tell the user the quota ran out — say the peek feature is having a technical problem, and offer a regular download as an alternative.]`
            }
            return `[view_link_post FAILED — ${err.message}. Offer the user an alternative such as a regular download, do not say "quota exhausted".]`
        }

        return await peekAnalyzeWithVision(mediaItems, platform, url, context)
    }
},
{
    name: 'search_web',
    description: 'Search for the latest information on the internet (Gemini native grounding via Google Search — model gemini-3.1-flash-lite, falling back to gemini-2.5-flash if it fails/hits a limit). Use it for news, prices, real-time data, or things that may have changed since training. IMPORTANT: after getting a result from this tool, your final reply to the user MUST go through the send_rich_reply tool (see rule 13) — NEVER answer directly with plain text that pastes the raw links from the "Sources:" section of this tool result.',
    parameters: {
        query: { type: 'string', description: 'The keywords or question to search for', required: true }
    },
    execute: async ({ query }) => {
        try {
            const result = await searchWebGrounded(query)
            if (!result?.answer) {
                return 'Search returned no answer for this query. Answer from your own knowledge and note that the info may not be up to date.'
            }

            const sources = (result.sources || [])
                .map(s => `• ${s.title}: ${s.url}`)
                .join('\n')
            const reminder = '\n\n[MANDATORY INSTRUCTION: do NOT answer the user directly with plain text. Call the send_rich_reply tool now — body = the summary above in natural language WITHOUT any links, citations = the list of {url, title} from the relevant sources above (they will appear as link buttons under the message).]'
            return result.answer + (sources ? `\n\nSources list (to be attached via send_rich_reply, do NOT paste it raw):\n${sources}` : '') + reminder
        } catch (e) {
            console.warn(`[search_web] Error: ${e.message}`)
            return `Search failed: ${e.message}. Answer from your own knowledge and note that the info may not be up to date.`
        }
    }
}
]
