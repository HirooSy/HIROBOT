async function askNotrack(sender, text, conn) {
  if (!conn.notrack) conn.notrack = {};

  const session = conn.notrack[sender] || {};

  const { result, session_id, chat_id } = await global.scraper.notrack.notrackChat({
    prompt: text,
    session_id: session.session_id || null,
    chat_id: session.chat_id || null
  });

  conn.notrack[sender] = { session_id, chat_id };

  return result;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return m.reply(`*NoTrack AI*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`);
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.notrack && conn.notrack[m.sender]) {
      delete conn.notrack[m.sender];
    }
    return m.reply('✅ History cleared.');
  }

  try {
    const reply = await askNotrack(m.sender, trimmed, conn);
    return m.reply(reply);
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return m.reply(`${msg}`);
  }
};

handler.help = handler.command = ['notrack', 'notrackai'];
handler.tags = ['ai'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true }

export default handler;
