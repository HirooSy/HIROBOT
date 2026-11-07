import axios from 'hiro/axios';
import crypto from 'crypto';

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const baseUrl = 'https://notrack.ai';

export async function notrackChat({
  prompt,
  session_id = null,
  chat_id = null,
  persona = 'normal',
  mode = 'usual'
}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Parameter prompt is required');
  }

  const effectiveSessionId = session_id || crypto.randomUUID();
  const cookieStr = `uid=${effectiveSessionId}`;

  const payload = {
    user_input: prompt.trim(),
    mode: mode || 'usual',
    model: 'C',
    persona: persona || 'normal',
    max_turns: 10,
    chat_id: chat_id || null,
    attachments: [],
    regenerate: false,
    edit: false,
    edit_mid: null,
    via: 'text'
  };

  const res = await axios.post(`${baseUrl}/api/dispatch`, payload, {
    headers: {
      'User-Agent': ua,
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Referer: `${baseUrl}/id/chat`,
      Cookie: cookieStr,
      Accept: 'text/event-stream'
    },
    responseType: 'stream',
    timeout: 35000
  });

  let fullAnswer = '';
  let returnedChatId = chat_id || null;

  await new Promise((resolve, reject) => {
    let hasError = false;

    res.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'chat_meta' && evt.chat_id) {
              returnedChatId = evt.chat_id;
            } else if (evt.type === 'delta' && evt.chunk) {
              fullAnswer += evt.chunk;
            } else if ((evt.type === 'message' || evt.type === 'consensus') && evt.content) {
              fullAnswer = evt.content;
            } else if (evt.type === 'error') {
              hasError = true;
              reject(new Error(evt.content || 'An error occurred from NoTrack AI'));
            }
          } catch (e) {
          }
        }
      }
    });

    res.data.on('end', () => {
      if (!hasError) resolve();
    });

    res.data.on('error', (err) => {
      if (!hasError) reject(err);
    });
  });

  if (!fullAnswer.trim()) {
    throw new Error('NoTrack AI did not return a response');
  }

  return {
    prompt: prompt.trim(),
    result: fullAnswer.trim(),
    session_id: effectiveSessionId,
    chat_id: returnedChatId
  };
}
