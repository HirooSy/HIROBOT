function formatResult(data) {
  const aiPercent = (data.ai * 100).toFixed(2);
  const humanPercent = (data.original * 100).toFixed(2);
  return `*AI:* ${aiPercent}%`;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return m.reply(`Enter some text.\nExample: ${usedPrefix + command} your text`);
  }

  try {
    const trimmed = text.trim();
    const data = await global.scraper.aicheck.scrapeOriginality(trimmed);
    return m.reply(formatResult(data));
  } catch (e) {
    return m.reply(`Error: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
  }
};

handler.help = handler.command = ['aicheck'];
handler.tags = ['tools'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true }

export default handler;
