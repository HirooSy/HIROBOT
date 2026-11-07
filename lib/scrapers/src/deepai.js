import axios from 'hiro/axios';
import crypto from 'crypto';

const defaultUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function generateDeepAIKey(userAgent = defaultUa) {
    const randomStr = Math.round(Math.random() * 100000000000).toString();
    const hash = str => crypto.createHash('md5').update(str, 'utf8').digest('hex').split('').reverse().join('');
    const salt = 'hackers_become_a_little_stinkier_every_time_they_hack';
    const hash1 = hash(userAgent + randomStr + salt);
    const hash2 = hash(userAgent + hash1);
    const hash3 = hash(userAgent + hash2);
    return `tryit-${randomStr}-${hash3}`;
}

export async function deepaiChat(messages, _options) {
    if (typeof messages === 'string') {
        return chatDeepAI(messages);
    }
    const userMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const history = messages
        .filter(m => m.content !== userMsg && (m.role === 'user' || m.role === 'assistant'))
        .map(m => ({ role: m.role, content: m.content }));
    return chatDeepAI(userMsg, history);
}

export async function chatDeepAI(prompt, history = []) {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
        throw new Error('Chat prompt cannot be empty.');
    }

    const apiKey = generateDeepAIKey(defaultUa);
    const messages = [...history, { role: 'user', content: cleanPrompt }];

    const formData = new FormData();
    formData.append('chat_style', 'chat');
    formData.append('chatHistory', JSON.stringify(messages));
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
    if (!reply) {
        throw new Error('No response from DeepAI.');
    }

    const cleanReply = reply.split('\x1c')[0].trim();
    return cleanReply || reply;
}
