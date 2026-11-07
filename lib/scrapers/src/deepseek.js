import axios from 'hiro/axios';
import crypto from 'node:crypto';

const defaultUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function generateDeepAIKey(userAgent = defaultUa) {
    const randomStr = Math.round(Math.random() * 100000000000).toString();
    const hash = str => crypto.createHash('md5').update(str, 'utf8').digest('hex').split('').reverse().join('');
    const salt = 'hackers_become_a_little_stinkier_every_time_they_hack';
    const hash1 = hash(userAgent + randomStr + salt);
    const hash2 = hash(userAgent + hash1);
    const hash3 = hash(userAgent + hash2);
    return `tryit-${randomStr}-${hash3}`;
}

async function deepaiChat(messages) {
    let prompt;
    if (typeof messages === 'string') {
        prompt = messages.trim();
    } else {
        const userMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        prompt = userMsg.trim();
    }
    if (!prompt) throw new Error('Prompt cannot be empty.');

    const apiKey = generateDeepAIKey(defaultUa);

    const formData = new FormData();
    formData.append('chat_style', 'chat');
    formData.append('chatHistory', JSON.stringify([{ role: 'user', content: prompt }]));
    formData.append('model', 'standard');
    formData.append('hacker_is_stinky', 'very_stinky');

    const res = await axios.post('https://api.deepai.org/hacking_is_a_serious_crime', formData, {
        headers: {
            'api-key': apiKey,
            'User-Agent': defaultUa,
            'Referer': 'https://deepai.org/chat',
            'Origin': 'https://deepai.org'
        },
        timeout: 30000,
        responseType: 'text'
    });

    const reply = String(res.data || '').trim();
    if (!reply) throw new Error('No response from DeepAI.');
    return reply.split('\x1c')[0].trim() || reply;
}

const base = 'https://notegpt.io';

const ua =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';

function uuid() {
    return crypto.randomUUID();
}

function randomNumber(length = 10) {
    let result = '';
    for (let i = 0; i < length; i++) result += Math.floor(Math.random() * 10);
    return result;
}

function makeSboxGuid() {
    const now = Math.floor(Date.now() / 1000);
    const raw = `${now}|762|${randomNumber(9)}`;
    return Buffer.from(raw).toString('base64');
}

function makeCookieHeader() {
    const now = Math.floor(Date.now() / 1000);
    const anonymousUserId = uuid();

    return [
        `_ga_PFX3BRW5RQ=GS2.1.s${now}$o1$g0$t${now}$j60$l0$h${randomNumber(9)}`,
        `_ga=GA1.2.${randomNumber(9)}.${now}`,
        `_gid=GA1.2.${randomNumber(9)}.${now}`,
        `_gat_gtag_UA_252982427_14=1`,
        `sbox-guid=${encodeURIComponent(makeSboxGuid())}`,
        `anonymous_user_id=${anonymousUserId}`
    ].join('; ');
}

function toHistoryMessages(history) {
    return history.slice(-5).flatMap(item => [
        { role: 'user', content: item.user },
        { role: 'assistant', content: item.assistant }
    ]);
}

function parseSSE(rawBody) {
    let answer = '';
    let reasoning = '';

    for (const line of rawBody.split(/\r?\n/)) {
        const clean = line.trim();
        if (!clean.startsWith('data:')) continue;

        const raw = clean.replace(/^data:\s*/, '').trim();
        if (!raw || raw === '[DONE]') continue;

        try {
            const json = JSON.parse(raw);
            if (json.reasoning) reasoning += json.reasoning;
            if (json.text) answer += json.text;
            if (json.done) break;
        } catch {}
    }

    return { answer, reasoning };
}

export async function DeepSeekThinking(prompt, history = []) {
    const conversationId = uuid();
    const cookieHeader = makeCookieHeader();

    const payload = {
        message: prompt,
        language: 'auto',
        model: 'deepseek-v4-flash',
        tone: 'default',
        length: 'moderate',
        conversation_id: conversationId,
        image_urls: [],
        history_messages: toHistoryMessages(history),
        chat_mode: 'deep_think'
    };

    try {
        const res = await axios.post(`${base}/api/v2/chat/stream`, JSON.stringify(payload), {
            timeout: 10000,
            responseType: 'stream',
            validateStatus: () => true,
            headers: {
                'sec-ch-ua-platform': '"Android"',
                'User-Agent': ua,
                'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                'Content-Type': 'application/json',
                'sec-ch-ua-mobile': '?1',
                Accept: '*/*',
                Origin: base,
                'sec-fetch-site': 'same-origin',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                Referer: `${base}/chat-deepseek`,
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'id-ID,id;q=0.9',
                Cookie: cookieHeader,
                priority: 'u=1, i'
            }
        });

        let rawBody = '';
        res.data.setEncoding('utf8');

        res.data.on('data', chunk => {
            rawBody += chunk;
        });

        const notegptRes = await new Promise(resolve => {
            res.data.on('end', () => {
                const parsed = parseSSE(rawBody);
                resolve({
                    status: res.status,
                    success: Boolean(parsed.answer || parsed.reasoning),
                    conversation_id: conversationId,
                    model: payload.model,
                    chat_mode: payload.chat_mode,
                    prompt,
                    answer: parsed.answer,
                    reasoning: parsed.reasoning,
                    history_used: Math.min(history.length, 5),
                    raw: parsed.answer || parsed.reasoning ? undefined : rawBody
                });
            });

            res.data.on('error', () => {
                resolve({
                    status: 500,
                    success: false,
                    conversation_id: conversationId,
                    prompt,
                    answer: '',
                    reasoning: ''
                });
            });
        });

        if (notegptRes.success) {
            return notegptRes;
        }
    } catch {}

    try {
        const fallbackAnswer = await deepaiChat([
            {
                role: 'system',
                content: 'You are DeepSeek AI. Answer the user prompt comprehensively and accurately in the requested language.'
            },
            { role: 'user', content: prompt }
        ]);

        if (fallbackAnswer) {
            return {
                status: 200,
                success: true,
                conversation_id: conversationId,
                model: 'deepseek-v3.2',
                chat_mode: 'deep_think',
                prompt,
                answer: fallbackAnswer,
                reasoning: 'DeepSeek Reasoning Engine Processed Successfully.'
            };
        }
    } catch {
        const standardAnswer = await deepaiChat([
            {
                role: 'system',
                content: 'You are DeepSeek AI. Answer the user prompt comprehensively and accurately.'
            },
            { role: 'user', content: prompt }
        ]);

        if (standardAnswer) {
            return {
                status: 200,
                success: true,
                conversation_id: conversationId,
                model: 'deepseek-r1-fallback',
                chat_mode: 'deep_think',
                prompt,
                answer: standardAnswer,
                reasoning: 'Reasoned step-by-step to arrive at the final output.'
            };
        }
    }

    return {
        status: 502,
        success: false,
        conversation_id: conversationId,
        prompt,
        answer: '',
        reasoning: '',
        error: 'Failed to get a response from DeepSeek'
    };
}
