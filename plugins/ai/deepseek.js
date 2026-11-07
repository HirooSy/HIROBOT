async function askDeepSeek(sender, text, conn) {
    if (!conn.deepseek) conn.deepseek = {};

    const history = conn.deepseek[sender] || [];

    const res = await global.scraper.deepseek.DeepSeekThinking(text, history);

    if (!res.success || !res.answer) {
        throw new Error(res.error || 'DeepSeek did not return a response.');
    }

    const updated = [...history, { user: text, assistant: res.answer }].slice(-10);
    conn.deepseek[sender] = updated;

    return res.answer;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) {
        return m.reply(`*DeepSeek*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`);
    }

    const trimmed = text.trim();

    if (trimmed.toLowerCase() === 'reset') {
        if (conn.deepseek && conn.deepseek[m.sender]) {
            delete conn.deepseek[m.sender];
        }
        return m.reply('✅ History cleared.');
    }

    try {
        const reply = await askDeepSeek(m.sender, trimmed, conn);
        return m.reply(reply);
    } catch (e) {
        const msg = e.response ? JSON.stringify(e.response.data) : e.message;
        return m.reply(`${msg}`);
    }
};

handler.help = handler.command = ['deepseek'];
handler.tags = ['ai'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true };

export default handler;
