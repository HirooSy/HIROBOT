import axios from 'hiro/axios';

const pollinationsUrl = 'https://text.pollinations.ai/openai';
const pollinationsHeaders = {
  'Content-Type': 'application/json',
  Referer: 'https://pollinations.ai/',
};

async function complete(messages) {
  const { data } = await axios.post(
    pollinationsUrl,
    { model: 'openai', messages, stream: false },
    { headers: pollinationsHeaders }
  );
  return data?.choices?.[0]?.message?.content?.trim() ?? '(empty)';
}

export { complete };
