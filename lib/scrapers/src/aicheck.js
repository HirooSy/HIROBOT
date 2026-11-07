import axios from 'hiro/axios';

const headers = {
  'accept': '*/*',
  'accept-language': 'id-ID',
  'content-type': 'application/json',
  'origin': 'https://corefreetools.originality.ai',
  'referer': 'https://corefreetools.originality.ai/',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'
};

const endpoint = 'https://api.originality.ai/api/v2-tools/free-tools/ai-scan';

async function scrapeOriginality(query) {
  const payload = { content: query };
  const { data } = await axios.post(endpoint, payload, { headers: headers });
  return data;
}

export { scrapeOriginality }
