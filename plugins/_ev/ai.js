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
} = (await import("../../lib/tools/mcp.js"))
import crypto from 'crypto'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const keyOk = () => getApiKeys().length > 0

const botNum = (conn) => (conn?.user?.id || '').split(':')[0].split('@')[0]
const botLid = (conn) => (conn?.user?.lid || '').split(':')[0].split('@')[0]
const toNum  = (jid)  => (jid || '').split(':')[0].split('@')[0]

function isBotMentioned(m, conn) {
    const bn = botNum(conn)
    const bl = botLid(conn)
    const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    return mentions.some(jid => {
        const n = toNum(jid)
        return n === bn || n === bl
    })
}

function isReplyToBot(m, conn) {
    const bn = botNum(conn)
    const bl = botLid(conn)
    const ctx = m.message?.extendedTextMessage?.contextInfo
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
    const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (!quoted) return false
    return !!(quoted.imageMessage || quoted.audioMessage || quoted.videoMessage || quoted.documentMessage || quoted.stickerMessage)
}

function mediaDefaultText(m) {
    const msg = m.message || {}
    const qmsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage || {}
    if (msg.stickerMessage || qmsg.stickerMessage) return 'React and respond simply and naturally to this sticker as if it were a real reply in our conversation'
    if (msg.imageMessage || qmsg.imageMessage)             return 'Analyze or describe this image if it needed or if there problem, if no react and respond simply and naturally to this image as if it were a real reply in our conversation'
    if (msg.audioMessage || qmsg.audioMessage)             return 'Transcribe and understand this voice note/audio'
    if (msg.videoMessage || qmsg.videoMessage)             return 'Describe this video'
    if (msg.documentMessage || qmsg.documentMessage)       return 'Read and summarize this document'
    return ''
}

// ─── Core AI Handler ──────────────────────────────────────────────────────────

async function handleAI(conn, m, rawText, modelKey = 'default', isOwner = false) {
    const senderJid = m.sender || m.key?.remoteJid
    const chat      = m.key?.remoteJid || m.chat

    // Check pending confirmation first
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
        const identity = await getUserIdentity(senderJid, db, conn)
        const keys = getApiKeys()

        const userInfo = identity.isOwner
            ? `Owner: ${identity.name}`
            : identity.registered
            ? `User: ${identity.name}`
            : `Unregistered user (${identity.number})`

        return conn.sendMessage(chat, {
            text: `*${process.env.BOT_NAME} — Info*\n- ${userInfo}\n- API Keys: ${keys.length ? `${keys.length} key active` : 'No Apikey'}\n- AI Tools: ${countTools()} tools\n- Default model: ${MODELS.default}`
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

    // API key validation
    if (!keyOk()) {
        return conn.sendMessage(chat, {
            text: '*process.env.AI_KEYS is not filled yet*'
        }, { quoted: m })
    }

    // Help display if no text or media present
    const hasContent = rawText.trim() || hasMedia(m) || hasQuotedMedia(m)
    if (!hasContent) {
        return conn.sendMessage(chat, {
            text: `*${process.env.BOT_NAME}*\n\n*Usage:*\n• \`.ai <question>\` — ask anything\n• \`.ai:flash-lite <text>\` — use lite model\n• \`.ai:pro <text>\` — use powerful model\n• Send image/audio then \`.ai\` — analyze media\n\n*Subcommand:*\n• \`.ai reset\` — clear conversation session\n• \`.ai info\` — AI status & API keys\n• \`.ai tools\` — active MCP tools list\n• \`.ai models\` — list available models\n\n*In group:* mention bot or reply to bot messages to chat without prefix`
        }, { quoted: m })
    }

    // Text content
    let userText = rawText.trim()
    if (!userText && (hasMedia(m) || hasQuotedMedia(m))) {
        userText = mediaDefaultText(m)
    }

    // Typing indicator
    await conn.sendPresenceUpdate?.('composing', chat).catch(() => {})

    let result
    try {
       
        result = await runAgent(conn, m, userText, {
            modelKey,
            isOwner,
            senderJid,
        })
    } catch (err) {
        
        console.error('[handleAI] unexpected runAgent() throw:', err)
        return conn.sendMessage(chat, { text: `❌ Unexpected error: ${err.message}` }, { quoted: m })
    }

    // Handle result
    if (result.type === 'confirm') {
        return conn.sendMessage(chat, { text: result.text }, { quoted: m })
    }

    if (result.type === 'error') {
        return conn.sendMessage(chat, { text: result.text }, { quoted: m })
    }

    // messageType: codeblock atau buttons — kirim via aiRich/nativeFlow
    if (result.type === 'message') {
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
                return await conn.sendMessage(chat, msg, { quoted: m })
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
        // Safety net: tangkap JSON codeblock/buttons yang lolos dari mcp.js
        if (result.text.includes('__type')) {
            try {
                const t = result.text.trim()
                const a = t.indexOf('{')
                const b = t.lastIndexOf('}')
                if (a !== -1 && b > a) {
                    const obj = JSON.parse(t.slice(a, b + 1))
                    if (obj.__type === 'codeblock') {
                        const d = obj
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
                        try {
                            const btns = (d.buttons || []).map(btn => {
                                const type = (btn.type || 'reply').toLowerCase()
                                if (type === 'url') return { text: btn.label || 'Link', url: btn.value || '', useWebview: true }
                                if (type === 'copy') return { text: btn.label || 'Copy', copy: btn.value || '' }
                                return { text: btn.label || 'Button', id: btn.value || '' }
                            })
                            const msg = { text: d.body || '', nativeFlow: btns }
                            if (d.footer) msg.footer = d.footer
                            return await conn.sendMessage(chat, msg, { quoted: m })
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
        await conn.sendMessage(chat, { text: result.text }, { quoted: m })
    }
}

// ─── Plugin Handler ────────────────────────────────────────────

let handler = async function (m, { conn, command, text, args, usedPrefix, isOwner }) {
    const modelKey = command.includes(':') ? command.split(':')[1] : 'default'
    await handleAI(conn, m, text || args.join(' '), modelKey, isOwner)
}

handler.command = /^ai(:[a-z-]+)?$/i
handler.help    = ['ai <text>', 'ai:flash-lite <text>', 'ai:pro <text>']
handler.tags    = ['ai']
handler.exp     = 0
handler.limit   = false
handler.premium = false
handler.group   = false
handler.private = false
handler.owner   = false
handler.admin   = false

// ─── Passive Listener ─────────────────────────────────────────────────────────

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
    
    const isOwner  = (await getUserIdentity(m.sender, db, conn)).isOwner || m.fromMe

    // Private chat
    if (!isGroup) {
        const chatDb = db.data.chats[chat]
        if (!chatDb?.aiChat && !chatDb?.gptChat) return

        const hasContent = text.trim() || hasMedia(m) || hasQuotedMedia(m)
        if (!hasContent) return

        await handleAI(conn, m, text, 'default', isOwner)
        return
    }

    // Group
    if (isGroup) {
        const mentioned = isBotMentioned(m, conn)
        const replied   = isReplyToBot(m, conn)
        if (!mentioned && !replied) return

        const chatDb = db?.data?.chats?.[chat]
        if (!chatDb?.aiChat && !chatDb?.gptChat) return

        const cleanedText = cleanText(text)
        await handleAI(conn, m, cleanedText, 'default', isOwner)
    }
  } catch (err) {
    console.error('[ai.js handler.all] Error caught, will not propagate:', err)
  }
}

export default handler
