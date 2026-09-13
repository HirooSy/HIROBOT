import axios from 'axios';
import crypto from 'crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_URL = 'https://notrack.ai';

export async function notrackChat({
  prompt,
  session_id = null,
  chat_id = null,
  persona = 'normal',
  mode = 'usual'
}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Parameter prompt wajib diisi');
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

  const res = await axios.post(`${BASE_URL}/api/dispatch`, payload, {
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/id/chat`,
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
              reject(new Error(evt.content || 'Terjadi kesalahan dari NoTrack AI'));
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
    throw new Error('NoTrack AI tidak memberikan respon jawaban');
  }

  return {
    prompt: prompt.trim(),
    result: fullAnswer.trim(),
    session_id: effectiveSessionId,
    chat_id: returnedChatId
  };
}

async function askNotrack(sender, text, conn) {
  if (!conn.notrack) conn.notrack = {};

  const session = conn.notrack[sender] || {};

  const { result, session_id, chat_id } = await notrackChat({
    prompt: text,
    session_id: session.session_id || null,
    chat_id: session.chat_id || null
  });

  conn.notrack[sender] = { session_id, chat_id };

  return result;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return conn.reply(
      m.chat,
      `*NoTrack AI*\n\n▸ ${usedPrefix + command} <pertanyaan>\n▸ ${usedPrefix + command} reset`,
      m
    );
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.notrack && conn.notrack[m.sender]) {
      delete conn.notrack[m.sender];
    }
    return conn.reply(m.chat, '✅ History cleared.', m);
  }

  try {
    const reply = await askNotrack(m.sender, trimmed, conn);
    return conn.reply(m.chat, reply, m);
  } catch (e) {
    console.error('[notrack]', e);
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    return conn.reply(m.chat, `${msg}`, m);
  }
};

handler.help = handler.command = ['notrack', 'notrackai'];
handler.tags = ['ai'];
handler.limit = 0;

export default handler;