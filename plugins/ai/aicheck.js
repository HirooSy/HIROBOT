import axios from 'axios';

const HEADERS = {
  'accept': '*/*',
  'accept-language': 'id-ID',
  'content-type': 'application/json',
  'origin': 'https://corefreetools.originality.ai',
  'referer': 'https://corefreetools.originality.ai/',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'
};

const ENDPOINT = 'https://api.originality.ai/api/v2-tools/free-tools/ai-scan';

async function scrapeOriginality(query) {
  const payload = { content: query };
  const { data } = await axios.post(ENDPOINT, payload, { headers: HEADERS });
  return data;
}

function formatResult(data) {
  const aiPercent = (data.ai * 100).toFixed(2);
  const humanPercent = (data.original * 100).toFixed(2);
  return `*AI:* ${aiPercent}%`;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return conn.reply(m.chat, `Masukkan teks.\nContoh: ${usedPrefix + command} teks kamu`, m);
  }

  try {
    const trimmed = text.trim();
    const data = await scrapeOriginality(trimmed);
    return m.reply(formatResult(data));
  } catch (e) {
    console.error('[aicheck]', e);
    return conn.reply(m.chat, `Error: ${e.response ? JSON.stringify(e.response.data) : e.message}`, m);
  }
};

handler.help = handler.command = ['aicheck'];
handler.tags = ['tools'];
handler.limit = 0;

export default handler;