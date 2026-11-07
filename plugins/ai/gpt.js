const handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) {
        return m.reply(`*ChatGPT*\n\n▸ ${usedPrefix + command} <prompt>\n\nExample: ${usedPrefix + command} apa itu AI?`);
    }

    try {
        const r = await global.scraper.gpt.chatgpt(text.trim());
        if (!r.ok) {
            return m.reply(`Failed (${r.stage || 'unknown'}):\n\`${r.status || 'no status'}\``);
        }
        if (!r.answer) {
            return m.reply('No response received from ChatGPT.');
        }
        return m.reply(r.answer);
    } catch (e) {
        return m.reply(`${e.message}`);
    }
};

handler.help = handler.command = ['gpt', 'chatgpt'];
handler.tags = ['ai'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true };

export default handler;
