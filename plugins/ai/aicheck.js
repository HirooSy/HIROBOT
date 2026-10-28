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
    return m.reply(`Enter some text.\nExample: ${usedPrefix + command} your text`);
  }

  try {
    const trimmed = text.trim();
    const data = await scrapeOriginality(trimmed);
    return m.reply(formatResult(data));
  } catch (e) {
    console.error('[aicheck]', e);
    return m.reply(`Error: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
  }
};

handler.help = handler.command = ['aicheck'];
handler.tags = ['tools'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true }

export default handler;