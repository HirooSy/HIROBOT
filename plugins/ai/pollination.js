import axios from '../../lib/package/axios.js';

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const POLLINATIONS_HEADERS = {
  'Content-Type': 'application/json',
  Referer: 'https://pollinations.ai/',
};

async function ask(sender, text, conn) {

  if (!conn.ai) {
    conn.ai = {};
  }

  if (!conn.ai[sender]) {
    conn.ai[sender] = [];
  }

  conn.ai[sender].push({ role: 'user', content: text });

  const payload = {
    model: 'openai',
    messages: conn.ai[sender],
    stream: false
  };

  const { data } = await axios.post(
    POLLINATIONS_URL,
    payload,
    { headers: POLLINATIONS_HEADERS }
  );

  const reply = data?.choices?.[0]?.message?.content?.trim() ?? '(empty)';
  conn.ai[sender].push({ role: 'assistant', content: reply });

  if (conn.ai[sender].length > 20) {
    conn.ai[sender] = conn.ai[sender].slice(-20);
  }

  return reply;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return m.reply(`*Free AI Chat*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`);
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.ai && conn.ai[m.sender]) {
      delete conn.ai[m.sender];
    }
    return m.reply('✅ History cleared.');
  }

  try {
    const reply = await ask(m.sender, trimmed, conn);
    return m.reply(reply);
  } catch (e) {
    console.error('[ai]', e);
    return m.reply(`${e.message}`);
  }
};

handler.help = handler.command = ['pollination'];
handler.tags = ['ai'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true }

export default handler;
