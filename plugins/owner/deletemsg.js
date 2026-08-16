import { delay } from 'baileys';

const handler = async (m, { conn }) => {
	if (!m.quoted) {
		return m.reply('Reply pesan yang ingin diproses.');
	}

	try {
		const chatId = m.chat;
		const stanzaId = m.quoted.id; //target stanza

		const tempId = await conn.relayMessage(
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

		const tempId2 = await conn.relayMessage(
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
			conn.sendMessage(chatId, {
				delete: {
					remoteJid: chatId,
					id: tempId,
					fromMe: true,
				},
			}),
			conn.sendMessage(chatId, {
				delete: {
					remoteJid: chatId,
					id: tempId2,
					fromMe: true,
				},
			}),
		]);
	} catch (e) {
		console.error('[dmsg]', e);
		await m.reply('Error: ' + (e?.message || e));
	}
};

handler.help = ['dmsg'];
handler.tags = ['owner'];
handler.command = /^dmsg$/i;
handler.group = true;
handler.owner = true

export default handler;