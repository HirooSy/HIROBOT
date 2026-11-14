import { delay } from 'baileys'

const lastMessageIdOf = target => (global.getidstore?.(target) || []).at(-1) || null

const normalizeGroupId = raw => {
  const groupId = raw.includes('@') ? raw : `${raw}@g.us`
  return /^\d[\d-]*@g\.us$/.test(groupId) ? groupId : null
}

const relaySpr = (conn, chatId, messageText, mentionedJid, messageId) => conn.relayMessage(chatId, {
  viewOnceMessage: {
    message: {
      interactiveMessage: {
        body: {
          text: messageText
        },
        nativeFlowMessage: {
          buttons: []
        },
        contextInfo: {
          isGroupStatus: false,
          mentionedJid
        }
      }
    }
  }
}, {
  messageId
})

const dmsg = async (conn, chatId, stanzaId) => {
  try {
    if (!conn || !chatId || !stanzaId) return false

    const tempId = await conn.relayMessage(chatId, {
      groupStatusMessageV2: {
        message: {
          extendedTextMessage: {
            text: '',
            contextInfo: {
              isGroupStatus: true
            }
          }
        }
      }
    }, {})

    const editId = await conn.relayMessage(chatId, {
      protocolMessage: {
        key: {
          remoteJid: chatId,
          fromMe: true,
          id: tempId
        },
        type: 14,
        editedMessage: {
          extendedTextMessage: {
            text: '\0',
            contextInfo: {
              isGroupStatus: false
            }
          }
        }
      }
    }, {
      messageId: stanzaId
    })

    await delay(100)

    await Promise.allSettled([
      ...Array.from({ length: 8 }, () =>
        conn.sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            id: tempId,
            fromMe: true
          }
        })
      ),
      conn.sendMessage(chatId, {
        delete: {
          remoteJid: chatId,
          id: editId,
          fromMe: true
        }
      })
    ])

    return true
  } catch {
    return false
  }
}

const handler = async (msg, { conn, text, command }) => {
  if (!text) {
    return msg.reply(
`╭━━━「 SPR & SPR2 」
│
│ 1. REPLY MESSAGE
│ .spr hello
│
│ Reply to the message you want to target,
│ then send the command.
│
│ 2. MENTION USER
│ .spr @628xxx | hello
│
│ Mention the user you want to target.
│ Their last stored message is used.
│
│ 3. TARGET NUMBER + GROUP
│ .spr 628xxx | hello | 120363xxxxxxxx@g.us
│
│ Uses the target's last stored message ID
│ and sends the text to the destination group.
│
│ 4. SPR2 MODE
│ .spr2 628xxx | hello | 120363xxxxxxxx@g.us
│
│ Same as mode 3, but the target's last
│ message is hidden first.
│
├━━━「 NOTES 」
│
│ global.store keeps incoming message IDs
│ so they can be looked up by number.
│ The store is cleared every 12 hours.
│
│ The target must have a message saved
│ in global.store.
│
╰━━━━━━━━━━━━━━━━━━`
    )
  }

  const isSpr2 = command === 'spr2'
  const parts = text.split('|').map(part => part.trim())

  try {
    let targetChat = msg.chat
    let messageText = text.trim()
    let mentionedJid = []
    let messageIds = []
    let isNumberMode = false

    if (parts.length >= 3) {
      const target = parts[0]
      messageText = parts.slice(1, -1).join('|').trim()

      if (!target || !messageText) {
        return msg.reply(
`Invalid format!

Example:
.spr 628123456789 | Hello | 120363xxxxxxxx@g.us

Or:
.spr2 628123456789 | Hello | 120363xxxxxxxx@g.us`
        )
      }

      const groupId = normalizeGroupId(parts.at(-1))

      if (!groupId) {
        return msg.reply(
`Invalid group ID!

Example:
.spr2 628123456789 | Hello | 120363xxxxxxxx@g.us`
        )
      }

      const lastId = lastMessageIdOf(target)

      if (!lastId) {
        return msg.reply(
`Target message not found in global.store!

Number: ${target}

Make sure the target has sent a message
while message saving is active.`
        )
      }

      targetChat = groupId
      isNumberMode = true
      messageIds = [lastId]
    } else if (parts.length === 2 && msg.mentionedJid?.length) {
      messageText = parts[1]

      if (!messageText) {
        return msg.reply(
`Message text is empty!

Example:
.spr @628123456789 | Hello`
        )
      }

      mentionedJid = [...new Set(msg.mentionedJid)]
      messageIds = [...new Set(mentionedJid.map(lastMessageIdOf).filter(Boolean))]

      if (!messageIds.length) {
        return msg.reply(
`No stored message found for the mentioned user!

Make sure the user has sent a message
while message saving is active.`
        )
      }
    } else {
      const quoted = msg.quoted

      if (!quoted) {
        return msg.reply(
`Target message not specified!

Reply to the target message:
.spr Hello

Or use a mention:
.spr @628123456789 | Hello

Or use a number and group:
.spr 628123456789 | Hello | 120363xxxxxxxx@g.us

SPR2 mode:
.spr2 628123456789 | Hello | 120363xxxxxxxx@g.us`
        )
      }

      const quotedId = quoted.id || quoted.vM?.key?.id

      if (!quotedId) {
        return msg.reply('The replied message ID was not found.')
      }

      messageIds = [quotedId]
    }

    await conn.sendMessage(msg.chat, {
      react: {
        text: '⏱️',
        key: msg.key
      }
    })

    for (const messageId of messageIds) {
      if (isSpr2 && isNumberMode) await dmsg(conn, targetChat, messageId)
      await relaySpr(conn, targetChat, messageText, mentionedJid, messageId)
    }

    if (!isNumberMode) await dmsg(conn, targetChat, msg.key.id)

    await msg.reply(
`Command processed!

Mode: ${isSpr2 ? 'SPR2' : 'SPR'}
Target messages: ${messageIds.length}
Destination group: ${targetChat}`
    )
  } catch (error) {
    await msg.reply(`An error occurred:\n${String(error)}`)
  } finally {
    await conn.sendMessage(msg.chat, {
      react: {
        text: '',
        key: msg.key
      }
    }).catch(() => {})
  }
}

handler.help = [
  'spr <text>',
  'spr @user | <text>',
  'spr <number> | <text> | <groupId>',
  'spr2 <number> | <text> | <groupId>'
]
handler.description = 'Send a message that only the target can read'
handler.tags = ['tools']
handler.command = ['spr', 'spr2']
handler.limit = true
handler.platform = { whatsapp: { permission: ['owner'] }, discord: false }

export default handler