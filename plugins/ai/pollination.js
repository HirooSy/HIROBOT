import axios from 'axios';

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const POLLINATIONS_HEADERS = {
  'Content-Type': 'application/json',
  Referer: 'https://pollinations.ai/',  
};

async function ask(sender, text, conn) {
  // Initialize conn.ai if it doesn't exist
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
    return conn.reply(
      m.chat,
      `*Free AI Chat*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`,
      m
    );
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.ai && conn.ai[m.sender]) {
      delete conn.ai[m.sender];
    }
    return conn.reply(m.chat, '✅ History cleared.', m);
  }

  try {
    const reply = await ask(m.sender, trimmed, conn);
    return conn.reply(m.chat, reply, m);
  } catch (e) {
    console.error('[ai]', e);
    return conn.reply(m.chat, `${e.message}`, m);
  }
};

handler.help = handler.command = ['pollination'];
handler.tags = ['ai'];
handler.limit = 0;

export default handler;