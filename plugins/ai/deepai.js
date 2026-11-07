async function askDeepAI(sender, text, conn) {
    if (!conn.deepai) conn.deepai = {};

    const history = conn.deepai[sender] || [];

    const reply = await global.scraper.deepai.chatDeepAI(text, history);

    const updated = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: reply }
    ].slice(-20);

    conn.deepai[sender] = updated;

    return reply;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) {
        return m.reply(`*DeepAI*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`);
    }

    const trimmed = text.trim();

    if (trimmed.toLowerCase() === 'reset') {
        if (conn.deepai && conn.deepai[m.sender]) {
            delete conn.deepai[m.sender];
        }
        return m.reply('✅ History cleared.');
    }

    try {
        const reply = await askDeepAI(m.sender, trimmed, conn);
        return m.reply(reply);
    } catch (e) {
        const msg = e.response ? JSON.stringify(e.response.data) : e.message;
        return m.reply(`${msg}`);
    }
};

handler.help = handler.command = ['deepai'];
handler.tags = ['ai'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true };

export default handler;
