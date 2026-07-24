import { plugins } from "../../lib/plugins.js"
const {
    proto,
    generateWAMessageFromContent,
    areJidsSameUser
} = (await import('baileys'))

export async function all(m, chatUpdate) {
    if (m.isBaileys) return
    if (!m.message) return

    const isInteractive = m.mtype === "interactiveResponseMessage"
    const isNativeFlow = !!m.message.nativeFlowResponseMessage
    const isButtons = !!m.message.buttonsResponseMessage
    const isTemplate = !!m.message.templateButtonReplyMessage
    const isList = !!m.message.listResponseMessage

    if (!(isInteractive || isNativeFlow || isButtons || isTemplate || isList)) return

    let id
    if (isButtons) {
        id = m.message.buttonsResponseMessage.selectedButtonId
    } else if (isTemplate) {
        id = m.message.templateButtonReplyMessage.selectedId
    } else if (isList) {
        id = m.message.listResponseMessage.singleSelectReply?.selectedRowId
    } else if (isInteractive || isNativeFlow) {
        try {
            const nativeFlow = m.message.interactiveResponseMessage?.nativeFlowResponseMessage
                ?? m.message.nativeFlowResponseMessage
            id = JSON.parse(nativeFlow?.paramsJson || '{}')?.id
        } catch (e) {
            id = null
        }
    }

    let text = m.message.buttonsResponseMessage?.selectedDisplayText
        || m.message.templateButtonReplyMessage?.selectedDisplayText
        || m.message.listResponseMessage?.title
        || id

    if (!id && !text) return

    let isIdMessage = false, usedPrefix

    for (let name in plugins) {
        let plugin = plugins[name]
        if (!plugin) continue
        if (plugin.disabled) continue
        if (!opts['restrict'])
            if (plugin.tags && plugin.tags.includes('admin')) continue
        if (typeof plugin !== 'function') continue
        if (!plugin.command) continue

        const str2Regex = str => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
        let _prefix = plugin.customPrefix ? plugin.customPrefix : this.prefix ? this.prefix : global.prefix
        let match = (
            _prefix instanceof RegExp ?
                [[_prefix.exec(id), _prefix]] :
            Array.isArray(_prefix) ?
                _prefix.map(p => {
                    let re = p instanceof RegExp ? p : new RegExp(str2Regex(p))
                    return [re.exec(id), re]
                }) :
            typeof _prefix === 'string' ?
                [[new RegExp(str2Regex(_prefix)).exec(id), new RegExp(str2Regex(_prefix))]] :
                [[[], new RegExp]]
        ).find(p => p[1])

        if ((usedPrefix = (match[0] || '')[0])) {
            let noPrefix = id.replace(usedPrefix, '')
            let [command] = noPrefix.trim().split` `.filter(v => v)
            command = (command || '').toLowerCase()

            let isId = plugin.command instanceof RegExp ?
                plugin.command.test(command) :
            Array.isArray(plugin.command) ?
                plugin.command.some(cmd => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
            typeof plugin.command === 'string' ?
                plugin.command === command :
                false

            if (!isId) continue
            isIdMessage = true
        }
    }

    const finalText = isIdMessage ? id : (text || id || '')
    if (!finalText) return

    // Bangun quoted object yang aman — inject contextInfo jika tidak ada
    let quotedObj = null
    if (m.quoted) {
        try {
            const fakeObj = m.quoted.fakeObj
            if (fakeObj && typeof fakeObj === 'object') {
                const msgContent = fakeObj.message ? { ...fakeObj.message } : {}
                const msgType = Object.keys(msgContent)[0]

                if (msgType && msgContent[msgType] && typeof msgContent[msgType] === 'object') {
                    // Inject contextInfo kosong jika tidak ada
                    if (!msgContent[msgType].contextInfo) {
                        msgContent[msgType] = {
                            ...msgContent[msgType],
                            contextInfo: {}
                        }
                    }
                    quotedObj = { ...fakeObj, message: msgContent }
                }
            }
        } catch (e) {
            console.error('Failed to build quotedObj:', e)
            quotedObj = null
        }
    }

    const messageOptions = {
        userJid: this.user.id,
        ...(quotedObj ? { quoted: quotedObj } : {})
    }

    const contentObj = {
        extendedTextMessage: {
            text: finalText,
            ...(m.mentionedJid?.length
                ? { contextInfo: { mentionedJid: m.mentionedJid } }
                : {}
            )
        }
    }

    let messages = await generateWAMessageFromContent(m.chat, contentObj, messageOptions)

    messages.key.fromMe = areJidsSameUser(m.sender, this.user.id)
    messages.key.id = m.key.id
    messages.pushName = m.name
    if (m.isGroup)
        messages.key.participant = messages.participant = m.sender

    let msg = {
        ...chatUpdate,
        messages: [proto.WebMessageInfo.fromObject(messages)].map(v => (v.conn = this, v)),
        type: 'append'
    }
    this.ev.emit('messages.upsert', msg)
}