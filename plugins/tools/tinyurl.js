const handler = async (m, { command, usedPrefix, text }) => {
  if (!text) return m.reply(`Example: ${usedPrefix + command} https://example.com`);
  try {
    const res  = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.text();
    await m.reply(data);
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