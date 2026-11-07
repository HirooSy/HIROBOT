const handler = async (m, { command, usedPrefix, text }) => {
  if (!text) return m.reply(`Example: ${usedPrefix + command} https://example.com`);
  try {
    await m.reply(await global.scraper.tinyurl.shorten(text));
  } catch (e) {
    await m.reply(`Failed to shorten URL!\n${e.message}`);
  }
};
handler.help = [{ name: 'url', type: 'string', required: true }];
handler.description = 'Shorten a long URL';
handler.tags = ['tools'];
handler.command = ['shorturl', 'tinyurl'];
handler.platform = { whatsapp: { permission: [] }, discord: { permission: [] } }
export default handler;