import axios from 'axios';
import crypto from 'crypto';

const headers = {
  'User-Agent': 'le-chat-mobile/2.3.0 (build:20300173; os_name:ios; device_category:smartphone; device_model:iPhone 14 Pro; device_manufacturer:Apple)',
  'Accept-Language': 'en',
  'Accept': '*/*',
  'Content-Type': 'application/json'
};

function generateUUID() {
  return crypto.randomUUID();
}

function parseCookies(arr) {
  return Object.fromEntries(
    (arr || []).map(c => {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      return i < 0 ? [] : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }).filter(e => e.length)
  );
}

async function getSession() {
  const url = 'https://chat.mistral.ai/api/trpc/event.sendEventToDatalake,event.sendEventToDatalake?batch=1';
  const payload = {
    "0": { "json": { "name": "app_downloaded", "properties": {} } },
    "1": {
      "json": {
        "name": "app_started", "properties": {
          "os": "iOS", "osVersion": "17.4.1", "deviceManufacturer": "Apple", "screenWidth": 393, "screenHeight": 852, "windowWidth": 393, "windowHeight": 852, "pixelRatio": 3, "fontScale": 1, "deviceColorScheme": "light", "preferredLocale": "id-ID", "permissions": { "notifications": "undetermined", "camera": "undetermined", "mediaLibrary": "denied" }
        }
      }
    }
  };

  const res = await axios.post(url, payload, { headers });
  const jar = parseCookies(res.headers['set-cookie']);
  const cookieString = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  await axios.post('https://chat.mistral.ai/api/trpc/user.acceptToS?batch=1',
    { "0": { "json": {} } },
    { headers: { ...headers, 'Cookie': cookieString } }
  );

  return { cookieString, stableIdentifier: generateUUID() };
}

async function createChat(messageText, auth) {
  const url = `https://chat.mistral.ai/api/trpc/message.newChat?batch=1`;

  const payload = {
    "0": {
      "json": {
        "files": [],
        "content": [{ "type": "text", "text": messageText }],
        "transcriptionsMetadata": null, "agentId": null, "agentsApiAgentId": null, "features": ["beta-websearch"], "integrations": [], "libraries": [], "productType": "chat", "projectId": null, "incognito": null, "chatId": null, "parentId": null, "parentVersion": null
      },
      "meta": { "values": { "transcriptionsMetadata": ["undefined"], "agentId": ["undefined"], "agentsApiAgentId": ["undefined"], "projectId": ["undefined"], "incognito": ["undefined"], "chatId": ["undefined"], "parentId": ["undefined"], "parentVersion": ["undefined"] }, "v": 1 }
    }
  };

  const r = await axios.post(url, payload, {
    headers: { ...headers, 'Cookie': auth.cookieString }
  });

  return r.data[0].result.data.json.chatId;
}

async function streamMistral(prompt, auth, chatId, isNewChat) {
  const messageId = generateUUID();

  const payload = {
    "chatId": chatId,
    "stableAnonymousIdentifier": auth.stableIdentifier,
    "platform": "mobile",
    "clientPromptData": {
      "currentDate": new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      "userTimezone": "T+00:00 (Asia/Makassar)"
    },
    "shouldAwaitStreamBackgroundTasks": true,
    "shouldUseMessagePatch": true,
    "supportedTaskCallbacks": ["ask_user_question", "ask_user_confirmation", "collect_workflow_input", "delegate_workflow_execution", "enable_connector"],
    "features": ["beta-websearch"],
    "integrations": [],
    "libraries": [],
    "mode": isNewChat ? "start" : "append",
    "messageId": isNewChat ? undefined : messageId,
    "messageInput": isNewChat ? undefined : [{ "type": "text", "text": prompt }],
    "disabledFeatures": isNewChat ? ["memory-inference"] : undefined,
    "messageFiles": isNewChat ? undefined : []
  };

  const stream = await axios.post('https://chat.mistral.ai/api/chat', payload, {
    headers: { ...headers, 'Cookie': auth.cookieString, 'Accept': 'text/event-stream' },
    responseType: 'stream'
  });

  return new Promise((resolve, reject) => {
    let text = '';
    let buf = '';

    stream.data.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const match = line.match(/^\d+:(.*)/);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            if (data.json && data.json.patches) {
              for (const patch of data.json.patches) {
                if (patch.op === 'append' && patch.path.includes('/text')) {
                  text += patch.value;
                } else if (patch.op === 'replace' && patch.path === '/contentChunks') {
                  if (Array.isArray(patch.value) && patch.value.length > 0 && patch.value[0].text) {
                    text += patch.value[0].text;
                  }
                }
              }
            }
          } catch {}
        }
      }
    });

    stream.data.on('end', () => resolve(text.trim()));
    stream.data.on('error', reject);
  });
}

async function askMistral(sender, text, conn) {
  if (!conn.mistral) conn.mistral = {};

  let session = conn.mistral[sender];

  if (!session) {
    const auth = await getSession();
    const chatId = await createChat(text, auth);
    const reply = await streamMistral(text, auth, chatId, true);
    conn.mistral[sender] = { auth, chatId };
    return reply;
  }

  const reply = await streamMistral(text, session.auth, session.chatId, false);
  return reply;
}

const handler = async (m, { conn, text, usedPrefix, command }) => {
  if (!text) {
    return conn.reply(
      m.chat,
      `*Mistral AI Chat*\n\n▸ ${usedPrefix + command} <question>\n▸ ${usedPrefix + command} reset`,
      m
    );
  }

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'reset') {
    if (conn.mistral && conn.mistral[m.sender]) {
      delete conn.mistral[m.sender];
    }
    return conn.reply(m.chat, '✅ History cleared.', m);
  }

  try {
    const reply = await askMistral(m.sender, trimmed, conn);
    return conn.reply(m.chat, reply, m);
  } catch (e) {
    console.error('[mistral]', e);
    return conn.reply(m.chat, `${e.message}`, m);
  }
};

handler.help = handler.command = ['mistral'];
handler.tags = ['ai'];
handler.limit = 0;

export default handler;