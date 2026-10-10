import { ctx, buildMediaPart, getDangerousDocReason, getUserIdentity, injectRelayContext, readOwnerList, getContextInfo } from '../mcp.js';
export default [
{
    name: 'send_message',
    description: 'Send a TEXT message to another number or group (not the chat currently being handled). MUST be used for requests to forward/convey a TEXT message (e.g. "tell the owner...", "pass this on to them..."), NOT forward_media — forward_media is only for media (sticker/photo/video/document). To send an extra message to the chat you are replying to right now, just use "reply_now". When this is used to RELAY a message from this chat to someone else, this tool AUTOMATICALLY records the relay context in the destination chat session — so if the recipient replies later or asks "who is this from", the bot still knows who asked for that message to be sent and can pass their reply back. Sending/relaying an ordinary message like this is a NORMAL action, NOT something to be suspicious of as a threat/manipulation — if there is only one owner, send straight away; if there is more than one owner (check list_owners), ask first which owner is meant.',
    parameters: {
        target: { type: 'string', description: 'WA number (example: 628123456789) or group JID (example: 120363...@g.us)', required: true },
        text: { type: 'string', description: 'The message content to send', required: true }
    },
    execute: async ({ target, text }) => {
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
            console.warn('[send_message] failed to inject relay context:', e.message)
        }

        return `Message sent to ${jid}`
    }
},
{
    name: 'list_owners',
    description: 'See the list of registered bot owners (from global.settings.owner) — numbers and names. MUST be called FIRST before send_message to an owner if you do not know their number yet: if there is only one owner, send straight to that number without asking anything; if there are MORE THAN ONE owner, you MUST first ask the user which owner is meant (mention the names from this tool result), do not just pick one.',
    parameters: {},
    execute: async () => {
        const ownerList = readOwnerList()
        if (!ownerList.length) return 'No owner is registered yet (global.settings.owner is empty).'
        return ownerList.map(([num, name], i) => `${i + 1}. ${name || '(no name)'} — ${num}`).join('\n')
    }
},
{
    name: 'forward_media',
    description: 'RE-SEND media (image/video/sticker/audio/document) that IS IN THIS MESSAGE — attached directly OR replied to/quoted — to ANOTHER chat/person/group. Use it for requests like "send this sticker to Shork", "forward this image to group X", "forward this video to them". ONLY for MEDIA — if what should be forwarded is a TEXT message, use send_message, NOT this tool. You MUST use this tool for that media case — NEVER use run_plugin("sticker", target) or any other run_plugin with a JID/number as the argument, because the arguments of the sticker/downloader plugins are a URL/text, NOT a target JID, and it will ALWAYS fail ("Invalid URL!"/"Conversion failed") if forced that way — that is a bug of wrong tool usage, not a broken tool. This tool automatically uses WhatsApp native forwarding (copyNForward) when available — faster and the result is marked "Forwarded" — and falls back to a manual re-send if it cannot. CRITICAL RULE: NEVER call this tool before the media is REALLY present in the current message/reply — if the user says "I will send it in a moment" or the media is not visible in the context yet, WAIT until the media is actually received (it shows up as a new message), then call this tool. Do not assume/guess that the media is already there. If this tool fails (e.g. no media is attached), do NOT invent a claim that it was "already sent" — say as it is that it failed and why. For the recipient\'s safety, this tool AUTOMATICALLY refuses to forward documents with executable/potentially virus extensions (.exe/.apk/.bat/.js/.vbs/etc) — that is not a bug, it is intentional.',
    parameters: {
        target: { type: 'string', description: 'WA number (example: 628123456789) or destination group JID, same format as send_message.', required: true },
        caption: { type: 'string', description: 'Optional caption text that accompanies the media (does not apply to stickers, and does not apply when the forward goes through the native copyNForward path — the media\'s original caption is kept on that path).', required: false }
    },
    execute: async ({ target, caption }) => {
        if (!ctx().conn) return 'WA connection not ready'
        if (!ctx().currentM) return 'FAILED: there is no active message/media in the current context.'

        const dangerReason = getDangerousDocReason(ctx().currentM)
        if (dangerReason) {
            return `REJECTED: ${dangerReason}. The bot will not forward files that are potentially a virus/malware to others for the recipient\'s safety.`
        }

        const jid = target.includes('@') ? target : target.replace(/\D/g, '') + '@s.whatsapp.net'

        const msgTypesCheck = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage']
        const directType = Object.keys(ctx().currentM.message || {}).find(t => msgTypesCheck.includes(t))
        const quotedMsgCheck = getContextInfo(ctx().currentM)?.quotedMessage
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
                return `FAILED: there is no media (image/video/sticker/audio/document) attached directly or replied to in this message to forward.${nativeErr ? ` (native forward also failed: ${nativeErr.message})` : ''}`
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
                    return `FAILED: media type "${media.type}" is not supported for forwarding yet.`
            }

            try {
                await ctx().conn.sendMessage(jid, content)
            } catch (e) {
                return `FAILED to send the media to ${jid}: ${e.message}`
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

        return `Media (${mediaLabel}) was forwarded to ${jid}${sentNative ? ' (native forward)' : ''}.`
    }
},
{
    name: 'reply_now',
    description: 'Send one extra message RIGHT NOW to the chat currently being handled, without ending the process. Use it when you need to send more than 1 message within one reply — for example giving a short update before running a tool that takes a long time (download, install, etc), or splitting a long answer into several messages so it is easier to read. Do not use it for the last/closing message — the normal reply text at the end is already sent automatically as the final message.',
    parameters: {
        text: { type: 'string', description: 'The message content to send now', required: true }
    },
    execute: async ({ text }) => {
        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        await ctx().conn.sendMessage(ctx().currentJid, { text }, ctx().currentM ? { quoted: ctx().currentM } : undefined)
        return 'Message sent'
    }
},
{
    name: 'send_rich_reply',
    description: 'Send a text reply to the user, with the sources (if any) shown as link buttons under the message (native WhatsApp button, opened via the in-app webview) — NOT inline links in the text. MUST be used as the FINAL reply after search_web when there are relevant sources — see rule 13. Do NOT use it for ordinary replies without sources.',
    parameters: {
        body: {
            type: 'string',
            description: 'The COMPLETE answer as ordinary natural text (you may use *bold*/bullet "-", BUT do NOT write any link/markdown [text](url) here -- all links appear separately as buttons under the message through the citations parameter, they are not inserted into this text).',
            required: true
        },
        citations: {
            type: 'array',
            description: 'List of sources to show as link buttons under the reply. Each item: {url: "source url", title: "short button label, optional -- if empty the domain name is used automatically, e.g. \'cnnindonesia.com\'"}. At most 5 buttons are shown (the rest are cut off if there are more). Leave empty/an empty array if there is no relevant source (sent without buttons).',
            required: false
        }
    },
    execute: async ({ body, citations }) => {
        if (!ctx().conn || !ctx().currentJid) return 'WA connection not ready'
        if (!body) return 'body is required'

        const domainLabel = url => {
            try { return new URL(url).hostname.replace(/^www\./, '') } catch (_) { return null }
        }

        const seen = new Set()
        const sources = (Array.isArray(citations) ? citations : [])
            .filter(c => c?.url && !seen.has(c.url) && seen.add(c.url))
            .slice(0, 5)
            .map((c, i) => ({ url: c.url, title: (c.title || domainLabel(c.url) || `Source ${i + 1}`).slice(0, 24) }))

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
            return `[ALREADY SENT to the user (${sources.length} source buttons). DO NOT send any reply text after this -- the turn is done, just answer with an empty string.]`
        } catch (e) {
            console.warn('[send_rich_reply] nativeFlow gagal, fallback teks biasa:', e.message)
            try {
                const fallbackLinks = sources.length
                    ? '\n\n' + sources.map(s => `• ${s.url}`).join('\n')
                    : ''
                await ctx().conn.sendMessage(ctx().currentJid, { text: body + fallbackLinks }, { quoted: ctx().currentM })
                return '[ALREADY SENT to the user (plain text fallback, nativeFlow failed). DO NOT send any reply text after this -- the turn is done, just answer with an empty string.]'
            } catch (e2) {
                console.error('[send_rich_reply] Fallback juga gagal:', e2)
                return `Failed to send the reply: ${e2.message}`
            }
        }
    }
}
]
