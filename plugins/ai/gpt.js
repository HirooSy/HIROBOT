import axios from 'axios';
import crypto from 'crypto';

const HOTBOT_URL = 'https://www.hotbot.com/api/chat';

function generateTempUuid() {
  const timestamp = Math.floor(Date.now() / 1000);
  const randomHex = crypto.randomBytes(8).toString('hex');
  return `yp7lPkXl-${timestamp}-${randomHex}`;
}

function parseSSEResponse(rawData) {
  let fullText = '';
  const lines = rawData.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ') && !trimmed.includes('[DONE]')) {
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        if (parsed.content) fullText += parsed.content;
      } catch {
        // baris bukan JSON valid, abaikan
      }
    }
  }

  return fullText;
}

async function askHotbot(sender, text, conn) {
  if (!conn.hotbot) conn.hotbot = {};

  if (!conn.hotbot[sender]) {
    conn.hotbot[sender] = {
      tempUuid: generateTempUuid(),
      messages: []
    };
  }

  const session = conn.hotbot[sender];
  session.messages.push({ role: 'user', content: text });

  const payload = JSON.stringify({
    messages: session.messages,
    model: 'gpt-5',
    camp: false
  });

  const { data: rawData } = await axios.post(HOTBOT_URL, payload, {
    headers: {
      'accept': '*/*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'cookie': `chatai_language=en; theme=light; temp_uuid=${session.tempUuid}`,
      'origin': 'https://www.hotbot.com',
      'referer': 'https://www.hotbot.com/',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'
    },
    responseType: 'text'
  });

  const reply = parseSSEResponse(rawData).trim() || '(empty)';
  session.messages.push({ role: 'assistant', content: reply });

  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  return reply;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return conn.reply(
      m.chat,
      `*GPT-5 (Hotbot)*\n\n▸ ${usedPrefix + command} <pertanyaan>\n▸ ${usedPrefix + command} reset`,
      m
    );
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.hotbot && conn.hotbot[m.sender]) {
      delete conn.hotbot[m.sender];
    }
    return conn.reply(m.chat, '✅ History cleared.', m);
  }

  try {
    const reply = await askHotbot(m.sender, trimmed, conn);
    return conn.reply(m.chat, reply, m);
  } catch (e) {
    console.error('[hotbot]', e);
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return conn.reply(m.chat, `${msg}`, m);
  }
};

handler.help = handler.command = ['gpt'];
handler.tags = ['ai'];
handler.limit = 0;

export default handler;