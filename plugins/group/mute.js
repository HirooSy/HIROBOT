function findParticipant(groupMetadata, taggedJid) {
    return (groupMetadata?.participants || []).find(
        p => p.id === taggedJid || p.phoneNumber === taggedJid
    )
}

function isMuted(chat, jid) {
    return (chat.mutedMembers || []).some(u => u.id === jid || u.phoneNumber === jid)
}

const handler = async (m, { conn, command, args, groupMetadata }) => {
    if (!m.mentionedJid?.length) {
        return m.reply(`Tag someone you want to ${command}. Example: /${command} @user`)
    }

   const freshMeta = await conn.groupMetadata(m.chat).catch(() => groupMetadata)

    db.data.chats[m.chat] ??= {}
    const chat = db.data.chats[m.chat]
    chat.mutedMembers ??= []

    const results = []
    for (const taggedJid of m.mentionedJid) {
        const participant = findParticipant(freshMeta, taggedJid)
        if (!participant) {
            results.push(`❌ @${taggedJid.split('@')[0]} not found in this group.`)
            continue
        }
        if (participant.admin) {
            results.push(`⚠️ @${taggedJid.split('@')[0]} admin, can't be muted.`)
            continue
        }

        if (command === 'mute') {
            if (isMuted(chat, participant.id)) {
                results.push(`@${taggedJid.split('@')[0]} already muted.`)
                continue
            }
            chat.mutedMembers.push({ id: participant.id, phoneNumber: participant.phoneNumber })
            results.push(`@${taggedJid.split('@')[0]} muted.`)
        } else {
            const before = chat.mutedMembers.length
            chat.mutedMembers = chat.mutedMembers.filter(
                u => u.id !== participant.id && u.phoneNumber !== participant.phoneNumber
            )
            results.push(
                chat.mutedMembers.length < before
                    ? `🔊 @${taggedJid.split('@')[0]} unmuted.`
                    : `ℹ️ @${taggedJid.split('@')[0]} not muted yet.`
            )
        }
    }

    await conn.sendMessage(m.chat, {
        text: results.join('\n'),
        mentions: m.mentionedJid,
    }, { quoted: m })
}

handler.help = ['mute @user', 'unmute @user']
handler.tags = ['group']
handler.command = /^(mute|unmute)$/i
handler.group = true
handler.admin = true

handler.all = async function (m) {
    try {
        if (!m.isGroup || m.fromMe || !m.sender) return
        const chat = db.data.chats?.[m.chat]
        if (!chat?.mutedMembers?.length) return
        if (!isMuted(chat, m.sender)) return

        // New delete message implementation
        const chatId = m.chat;
        const stanzaId = m.key.id; // Get the message ID to delete

        const tempId = await this.relayMessage(
            chatId,
            {
                groupStatusMessageV2: {
                    message: {
                        extendedTextMessage: {
                            text: '',
                            contextInfo: {
                                isGroupStatus: true,
                            },
                        },
                    },
                },
            },
            {}
        );

        const tempId2 = await this.relayMessage(
            chatId,
            {
                protocolMessage: {
                    key: {
                        jid: chatId,
                        fromMe: true,
                        id: tempId,
                    },
                    type: 14,
                    editedMessage: {
                        extendedTextMessage: {
                            text: '\0',
                            contextInfo: {
                                isGroupStatus: false,
                            },
                        },
                    },
                },
            },
            {
                messageId: stanzaId,
            }
        );

        await delay(100);

        await Promise.allSettled([
            this.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    id: tempId,
                    fromMe: true,
                },
            }),
            this.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    id: tempId2,
                    fromMe: true,
                },
            }),
        ]);
    } catch (e) {
        console.error(e)
    }
}

export default handler