const {
    runAgent,
    runAgentConfirmed,
    resetSession,
    resetRateLimit,
    listTools,
    countTools,
    hasPending,
    cancelPending,
    getUserIdentity,
    getApiKeys,
    MODELS,
    getContextInfo,
} = (await import("../../lib/package/ai/mcp.js"))
import crypto from 'crypto'

const keyOk = () => getApiKeys().length > 0

const botNum = (conn) => (conn?.user?.id || '').split(':')[0].split('@')[0]
const botLid = (conn) => (conn?.user?.lid || '').split(':')[0].split('@')[0]
const toNum  = (jid)  => (jid || '').split(':')[0].split('@')[0]

function isBotMentioned(m, conn) {
    const bn = botNum(conn)
    const bl = botLid(conn)
    const mentions = getContextInfo(m)?.mentionedJid || []
    return mentions.some(jid => {
        const n = toNum(jid)
        return n === bn || n === bl
    })
}

function isReplyToBot(m, conn) {
    const bn = botNum(conn)
    const bl = botLid(conn)
    const ctx = getContextInfo(m)
    if (!ctx) return false
    const quotedNum = toNum(ctx.participant)
    return quotedNum === bn || quotedNum === bl
}

function cleanText(text) {
    return (text || '').replace(/@\d+/g, '').trim()
}

function extractText(m) {
    const msg = m.message || {}
    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        ''
    )
}

function hasMedia(m) {
    const msg = m.message || {}
    return !!(msg.imageMessage || msg.audioMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage)
}

function hasQuotedMedia(m) {
    const quoted = getContextInfo(m)?.quotedMessage
    if (!quoted) return false
    return !!(quoted.imageMessage || quoted.audioMessage || quoted.videoMessage || quoted.documentMessage || quoted.stickerMessage)
}

function mediaDefaultText(m) {
    const msg = m.message || {}
    const qmsg = getContextInfo(m)?.quotedMessage || {}

    if (msg.stickerMessage) return 'React and respond simply and naturally to this sticker as if it were a real reply in our conversation'
    if (msg.imageMessage)   return 'Analyze or describe this image if it needed or if there problem, if no react and respond simply and naturally to this image as if it were a real reply in our conversation'
    if (msg.audioMessage)   return 'Transcribe and understand this voice note/audio'
    if (msg.videoMessage)   return 'Describe this video'
    if (msg.documentMessage) return 'Read and summarize this document'

    if (qmsg.stickerMessage) return 'React and respond simply and naturally to this sticker as if it were a real reply in our conversation'
    if (qmsg.imageMessage)   return 'Analyze or describe this image if it needed or if there problem, if no react and respond simply and naturally to this image as if it were a real reply in our conversation'
    if (qmsg.audioMessage)   return 'Transcribe and understand this voice note/audio'
    if (qmsg.videoMessage)   return 'Describe this video'
    if (qmsg.documentMessage) return 'Read and summarize this document'
    return ''
}

async function handleAI(conn, m, rawText, modelKey = 'default', isOwner = false) {
    const senderJid = m.sender || m.key?.remoteJid
    const chat      = m.key?.remoteJid || m.chat

    let explicitContextInfo = m.msg?.contextInfo || null
    if (!explicitContextInfo) {
        const commonKeys = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'audioMessage']
        for (const k of commonKeys) {
            const v = m.message?.[k]
            if (v && typeof v === 'object' && v.contextInfo) {
                explicitContextInfo = v.contextInfo
                break
            }
        }
    }

    if (hasPending(senderJid)) {
        const reply = (text) => conn.sendMessage(chat, { text }, { quoted: m })
        const answer = rawText.trim().toLowerCase()

        if (['ya', 'yes', 'ok', 'oke', 'lanjut', 'confirm'].includes(answer)) {
            await conn.sendPresenceUpdate?.('composing', chat).catch(() => {})
            const result = await runAgentConfirmed(conn, m, { senderJid, isOwner })
            return reply(result.text)
        }

        if (['batal', 'no', 'tidak', 'cancel', 'stop'].includes(answer)) {
            cancelPending(senderJid)
            return reply('❌ Cancelled.')
        }

        cancelPending(senderJid)
    }

    const sub = rawText.trim().toLowerCase()

    if (sub === 'reset') {
        resetSession(senderJid)
        resetRateLimit(senderJid)
        return m.react("🔄")
    }

    if (sub === 'info') {
        const identity = await getUserIdentity(senderJid, global.db, conn)
        const keys = getApiKeys()

        const userInfo = identity.isOwner
            ? `Owner: ${identity.name}`
            : identity.registered
            ? `User: ${identity.name}`
            : `Unregistered user (${identity.number})`

        return conn.sendMessage(chat, {
            text: `*${global.settings.botname} — Info*\n- ${userInfo}\n- API Keys: ${keys.length ? `${keys.length} key active` : 'No Apikey'}\n- AI Tools: ${countTools()} tools\n- Default model: ${MODELS.default}`
        }, { quoted: m })
    }

    if (sub === 'tools') {
        const tools = listTools()
        if (!tools.length) return conn.sendMessage(chat, { text: 'There is no tool yet.' }, { quoted: m })
        return conn.sendMessage(chat, {
            text: `*AI Tools (${tools.length})*\n\n` +
                  tools.map((t, i) => `${i + 1}. \`${t}\``).join('\n')
        }, { quoted: m })
    }

    if (sub === 'models') {
        return conn.sendMessage(chat, {
            text: `*Available Models*\n\n- \`.ai\` / \`.ai:flash-lite\` → Gemini 3.1 Flash Lite *(default)* — fast, can search & run all tools\n- \`.ai:flash\` → Gemini 3.5 Flash — more accurate, can search & run all tools\n- \`.ai:pro\` → Gemini 2.5 Pro — most powerful for strong reasoning, can search & run all tools\n- \`.ai:gemma\` → Gemma 4 31B-it — open-source, powerful for reasoning/coding/analysis & REPAIR of code that you paste directly in chat, *Cannot search & Cannot run tools* (pure text chat)\n- \`.ai:gemma-moe\` → Gemma 4 26B-A4B (MoE) — same as gemma but more resource efficient, ⚠️ *Can NOT search & CANNOT run tools*\n\nExample: \`.ai:pro tell me about blackhole\`\nExample: \`.ai:gemma create a sorting function in python\`\nExample: \`.ai:gemma [paste your error code] Fix it\``
        }, { quoted: m })
    }

    const hasContent = rawText.trim() || hasMedia(m) || hasQuotedMedia(m)
    if (!hasContent) {
        return conn.sendMessage(chat, {
            text: `*${global.settings.botname}*\n\n*Usage:*\n• \`.ai <question>\` — ask anything\n• \`.ai:flash-lite <text>\` — use lite model\n• \`.ai:pro <text>\` — use powerful model\n• Send image/audio then \`.ai\` — analyze media\n\n*Subcommand:*\n• \`.ai reset\` — clear conversation session\n• \`.ai info\` — AI status & API keys\n• \`.ai tools\` — active MCP tools list\n• \`.ai models\` — list available models\n\n*In group:* mention bot or reply to bot messages to chat without prefix`
        }, { quoted: m })
    }

    let userText = rawText.trim()
    if (!userText && (hasMedia(m) || hasQuotedMedia(m))) {
        userText = mediaDefaultText(m)
    }

    await conn.sendPresenceUpdate?.('composing', chat).catch(() => {})

    const thinkingOn = !!global.settings?.ai?.thinking
    let statusKey = null
    let statusAlive = false
    let onStep = null

    if (thinkingOn) {
        try {
            const sent = await conn.sendMessage(chat, { text: '> ...' }, { quoted: m })
            statusKey = sent?.key || null
            statusAlive = !!statusKey
        } catch (e) {
            statusKey = null
            statusAlive = false
        }

        if (statusKey) {
            onStep = async (label) => {
                if (!statusAlive) return
                try {
                    await conn.sendMessage(chat, { edit: statusKey, text: `> ${label}` })
                } catch (_) {

                    statusAlive = false
                }
            }
        }
    }

    const clearStatus = async () => {
        if (!statusKey || !statusAlive) return
        statusAlive = false
        try {
            await conn.sendMessage(chat, { delete: statusKey })
        } catch (_) {}
    }

    const finishStatus = async (finalText) => {
        if (!statusKey || !statusAlive) return false
        statusAlive = false
        try {
            await conn.sendMessage(chat, { edit: statusKey, text: finalText })
            return true
        } catch (_) {
            return false
        }
    }

    let result
    try {

        result = await runAgent(conn, m, userText, {
            modelKey,
            isOwner,
            senderJid,
            onStep,
            contextInfo: explicitContextInfo,
        })
    } catch (err) {

        console.error('[handleAI] unexpected runAgent() throw:', err)
        await clearStatus()
        return conn.sendMessage(chat, { text: `❌ Unexpected error: ${err.message}` }, { quoted: m })
    }

    if (result.type === 'confirm' || result.type === 'error') {

        if (await finishStatus(result.text)) return
        await clearStatus()
        return conn.sendMessage(chat, { text: result.text }, { quoted: m })
    }

    if (result.type === 'message') {
        await clearStatus()
        const { messageType, messageData: d } = result
        if (messageType === 'codeblock') {
            try {
                const rich = conn.aiRich()
                if (d.title) rich.setTitle(d.title)
                if (d.description) rich.addText(`${d.description}
`, { hyperlink: true })
                rich.addCode(d.language || 'text', d.code || '')
                return await rich.send(chat, { quoted: m })
            } catch (e) {
                let msg = ''
                if (d.title) msg += `*${d.title}*

`
                if (d.description) msg += `${d.description}

`
                msg += `\`\`\`${d.language || 'text'}
${d.code || ''}
\`\`\``
                return conn.sendMessage(chat, { text: msg }, { quoted: m })
            }
        }
        if (messageType === 'buttons') {
            try {
                const btns = (d.buttons || []).map(btn => {
                    const type = (btn.type || 'reply').toLowerCase()
                    if (type === 'url')  return { text: btn.label || 'Link', url: btn.value || '', useWebview: true }
                    if (type === 'copy') return { text: btn.label || 'Copy', copy: btn.value || '' }
                    return { text: btn.label || 'Button', id: btn.value || '' }
                })
                const msg = { text: d.body || '', nativeFlow: btns }
                if (d.footer) msg.footer = d.footer
                return await conn.sendButton(chat, msg, m )
            } catch (e) {
                const lines = [d.body || '']
                if (d.footer) lines.push(`_${d.footer}_`)
                ;(d.buttons || []).forEach(b => lines.push(`• ${b.label}: ${b.value}`))
                return conn.sendMessage(chat, { text: lines.join('\n') }, { quoted: m })
            }
        }
        return
    }

    if (result.text) {

        if (result.text.includes('__type')) {
            try {
                const t = result.text.trim()
                const a = t.indexOf('{')
                const b = t.lastIndexOf('}')
                if (a !== -1 && b > a) {
                    const obj = JSON.parse(t.slice(a, b + 1))
                    if (obj.__type === 'codeblock') {
                        const d = obj
                        await clearStatus()
                        try {
                            const rich = conn.aiRich()
                            if (d.title) rich.setTitle(d.title)
                            if (d.description) rich.addText(d.description + '\n', { hyperlink: true })
                            rich.addCode(d.language || 'text', d.code || '')
                            return await rich.send(chat, { quoted: m })
                        } catch (_) {
                            const msg = (d.title ? '*' + d.title + '*\n\n' : '')
                                + (d.description ? d.description + '\n\n' : '')
                                + '```' + (d.language || 'text') + '\n' + (d.code || '') + '\n```'
                            return conn.sendMessage(chat, { text: msg }, { quoted: m })
                        }
                    }
                    if (obj.__type === 'buttons') {
                        const d = obj
                        await clearStatus()
                        try {
                            const btns = (d.buttons || []).map(btn => {
                                const type = (btn.type || 'reply').toLowerCase()
                                if (type === 'url') return { text: btn.label || 'Link', url: btn.value || '', useWebview: true }
                                if (type === 'copy') return { text: btn.label || 'Copy', copy: btn.value || '' }
                                return { text: btn.label || 'Button', id: btn.value || '' }
                            })
                            const msg = { text: d.body || '', nativeFlow: btns }
                            if (d.footer) msg.footer = d.footer
                            return await conn.sendButton(chat, msg, m)
                        } catch (_) {
                            const lines = [d.body || '']
                            if (d.footer) lines.push('_' + d.footer + '_')
                            ;(d.buttons || []).forEach(b => lines.push('• ' + b.label + ': ' + b.value))
                            return conn.sendMessage(chat, { text: lines.join('\n') }, { quoted: m })
                        }
                    }
                }
            } catch (_) {}
        }

        if (await finishStatus(result.text)) return
        await clearStatus()
        await conn.sendMessage(chat, { text: result.text }, { quoted: m })
        return
    }

    await clearStatus()
}

let handler = async function (m, { conn, command, text, args, usedPrefix, isOwner }) {
    const modelKey = command.includes(':') ? command.split(':')[1] : 'default'
    await handleAI(conn, m, text || args.join(' '), modelKey, isOwner)
}

handler.command = /^ai(:[a-z-]+)?$/i
handler.help    = ['ai <text>']
handler.tags    = ['ai']

handler.all = async function (m) {
  try {
    if (m.fromMe) return
    if (m.isBaileys) return
    if (m.sender == this.user.jid) return
    if ((m.id).startsWith('3EB0')) return
    if ((m.chat).endsWith('@broadcast')) return
    if ((m.chat).endsWith('@newsletter')) return

    const conn = this

    const stripToDigits = (jid) => String(jid || '').replace(/[^0-9]/g, '')
    const botNumber    = stripToDigits(this.user.jid || this.user.id)
    const senderNumber = stripToDigits(m.sender)
    if (botNumber && senderNumber && botNumber === senderNumber) return

    const _pref = this.prefix ?? global.prefix
    const prefixRe = _pref instanceof RegExp ? _pref
        : Array.isArray(_pref)
            ? new RegExp('^[' + _pref.map(p => p.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('') + ']')
            : new RegExp('^' + String(_pref).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'))

    const text = String(extractText(m) || '')
    if (prefixRe.test(text.trim())) return

    const chat     = m.key?.remoteJid || m.chat
    const isGroup  = String(chat || '').endsWith('@g.us')

    const isOwner  = (await getUserIdentity(m.sender, global.db, conn)).isOwner || m.fromMe

    if (!isGroup) {
        const chatDb = global.db.data.chats[chat]
        if (!chatDb?.aiChat && !chatDb?.gptChat) return

        const hasContent = text.trim() || hasMedia(m) || hasQuotedMedia(m)
        if (!hasContent) return

        await handleAI(conn, m, text, 'default', isOwner)
        return
    }

    if (isGroup) {
        const mentioned = isBotMentioned(m, conn)
        const replied   = isReplyToBot(m, conn)
        if (!mentioned && !replied) return

        const chatDb = global.db?.data?.chats?.[chat]
        if (!chatDb?.aiChat && !chatDb?.gptChat) return

        const cleanedText = cleanText(text)
        await handleAI(conn, m, cleanedText, 'default', isOwner)
    }
  } catch (err) {
    console.error('[ai.js handler.all] Error caught, will not propagate:', err)
  }
}

export default handler
