import { MODELS, captureWebsiteScreenshot, collectLinkMedia, createGeminiClient, detectPlatform, fetchWebsiteHtmlFallback, getApiKeys, getNextKey, getPersonality, peekAnalyzeWithVision, pickTweetUrl, searchWebGrounded } from '../mcp.js';

export default [
{
    name: 'view_website',
    description: 'Take a full-page desktop screenshot of a GENERAL website (not TikTok/Instagram/YouTube/Twitter-X/Facebook) and analyze its content visually using Gemini Vision. Use this tool when the user asks to check the content of a website/link post OUTSIDE those social platforms (e.g. e621, artstation, a blog, an online shop, github, etc) — to see how a page looks or to let the AI know what is at a URL. The screenshot is taken from screenshotmachine.com (full-page, desktop mode). Result: the AI will describe/analyze the visual content of that page. Do NOT use this tool for TikTok/Instagram/YouTube/Twitter/Facebook URLs — use view_link_post for those (it downloads the original media from the platform scraper and sends it to Gemini, not a generic browser screenshot).',
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
            console.warn(`[view_website] Screenshot failed for "${targetUrl}", falling back to raw HTML:`, err.message)
        }

        const apiKey = getNextKey()
        if (!apiKey && getApiKeys().length) return 'No Gemini API key available for analysis.'
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
        if (!apiKey && getApiKeys().length) return 'No Gemini API key available for analysis.'
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
    description: 'See the REAL content of a SPECIFIC TikTok / Instagram (reels, posts, carousels) / YouTube / Twitter-X / Facebook link. The tool downloads the actual media from the post (video, audio, photos, GIF) and sends that media to Gemini, then the AI reacts/comments on what it saw and heard. YOU MUST USE THIS TOOL (not view_website) for these platforms. Use it when the user shares a link from one of them and does NOT ask to download, but wants the AI to know about/comment on that post. Example triggers: "check this", "take a look", "what do you think", "react to this", "cek", "liat", or the user sends a link without a download instruction.',
    parameters: {
        url: { type: 'string', description: 'URL post (TikTok, Instagram, YouTube, Twitter/X, Facebook)', required: true },
        context: { type: 'string', description: 'The user\'s specific context or question about this content (optional)', required: false }
    },
    execute: async ({ url, context = '' }) => {
        const platform = detectPlatform(url)
        if (platform === 'unknown') {
            return `Unknown platform for peek. Try using view_website to see the content of this URL.`
        }

        let collected
        try {
            collected = await collectLinkMedia(platform === 'twitter' ? pickTweetUrl(url) : url)
        } catch (err) {
            console.warn(`[view_link_post] Failed to fetch media from ${platform}:`, err.message)
            const isModuleErr = err.message.includes("does not provide") || err.message.includes("Cannot find module")
            if (isModuleErr) {
                return `[view_link_post INTERNAL ERROR — scraper module not found: ${err.message}. This is a code bug, not an exhausted quota. Do not tell the user the quota ran out — say the peek feature is having a technical problem, and offer a regular download as an alternative.]`
            }
            return `[view_link_post FAILED — ${err.message}. Tell the user honestly that the media of this link could not be downloaded right now and why in simple words, and offer a regular download as an alternative. Do not say "quota exhausted" and do not describe the content, you did not see it.]`
        }

        const extra = [
            collected.caption ? `Post caption: ${collected.caption}` : '',
            ...collected.notes,
            context
        ].filter(Boolean).join(' — ')

        return await peekAnalyzeWithVision(collected.items, platform, url, extra)
    }
},
{
    name: 'search_web',
    description: 'Search for the latest information on the internet (Gemini native grounding via Google Search — model gemini-3.1-flash-lite, falling back to gemini-3.8-flash if it fails/hits a limit). Use it for news, prices, real-time data, or things that may have changed since training. IMPORTANT: after getting a result from this tool, your final reply to the user MUST go through the send_rich_reply tool (see rule 13) — NEVER answer directly with plain text that pastes the raw links from the "Sources:" section of this tool result.',
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
