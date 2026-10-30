
import axios from '../../package/axios.js';

const HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'id,en;q=0.9',
    origin: 'https://nanobanana.im',
};

const REQ_TIMEOUT = 15000;
const MAIL_POLL_INTERVAL = 3000;
const MAIL_POLL_MAX_TRIES = 40;
const TASK_POLL_INTERVAL = 4000;
const TASK_POLL_MAX_TRIES = 45;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mergeCookies(existing, setCookieArr) {
    if (!setCookieArr || !setCookieArr.length) return existing;
    return [...existing, ...setCookieArr];
}

function cookieHeaderFrom(cookies) {
    return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function getMagicLink(email) {
    for (let i = 0; i < MAIL_POLL_MAX_TRIES; i++) {
        try {
            const res = await axios.get(
                `https://api.tempmail.ing/api/emails/${encodeURIComponent(email)}`,
                { headers: HEADERS, timeout: REQ_TIMEOUT }
            );
            const emails = res.data?.emails;
            if (res.data?.success && emails?.length) {
                const text = emails[0].text || emails[0].html || '';
                const match = text.match(
                    /https:\/\/nanobanana\.im\/api\/auth\/magic-link\/verify\?token=[^\s"']+/
                );
                if (match) return match[0];
            }
        } catch (_) {
        }
        await delay(MAIL_POLL_INTERVAL);
    }
    throw new Error('Timeout waiting for the magic link to sign in.');
}

async function createAuthedSession() {
    const mailRes = await axios.post(
        'https://api.tempmail.ing/api/generate',
        {},
        { headers: HEADERS, timeout: REQ_TIMEOUT }
    );
    if (!mailRes.data?.success) throw new Error('Failed to create tempmail.');
    const email = mailRes.data.email.address;

    const session = axios.create({ headers: HEADERS, timeout: REQ_TIMEOUT });
    let cookies = [];

    const initRes = await session.get('https://nanobanana.im/');
    cookies = mergeCookies(cookies, initRes.headers['set-cookie']);
    let cookieHeader = cookieHeaderFrom(cookies);

    const magicRes = await session.post(
        'https://nanobanana.im/api/auth/sign-in/magic-link',
        { email, callbackURL: '/' },
        { headers: { Cookie: cookieHeader } }
    );
    if (!magicRes.data?.status) throw new Error('Failed to send magic link.');

    const link = await getMagicLink(email);
    const verifyRes = await session.get(link, {
        headers: { Cookie: cookieHeader },
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
    });
    cookies = mergeCookies(cookies, verifyRes.headers['set-cookie']);
    cookieHeader = cookieHeaderFrom(cookies);

    const homeRes = await session.get('https://nanobanana.im/', {
        headers: { Cookie: cookieHeader },
    });
    cookies = mergeCookies(cookies, homeRes.headers['set-cookie']);
    cookieHeader = cookieHeaderFrom(cookies);

    return { session, cookieHeader };
}

async function createAndPollTask(session, cookieHeader, payload) {
    const taskRes = await session.post(
        'https://nanobanana.im/api/img/nano-banana5',
        payload,
        { headers: { Cookie: cookieHeader } }
    );

    const taskId = taskRes.data?.taskId;
    if (!taskId) {
        throw new Error('Failed to create image task. Check turnstileToken or session.');
    }

    for (let i = 0; i < TASK_POLL_MAX_TRIES; i++) {
        const checkRes = await session.post(
            'https://nanobanana.im/api/img/nano-banana5/taskResult',
            { taskId },
            { headers: { Cookie: cookieHeader } }
        );
        if (checkRes.data?.status === 1) {
            const d = checkRes.data;
            const raw = d.imgAfterSrcs || d.images || d.imgAfterSrc || d.results;
            const urls = Array.isArray(raw) ? raw : [raw];
            return urls.filter(Boolean);
        }
        await delay(TASK_POLL_INTERVAL);
    }
    throw new Error('Timeout waiting for the image result.');
}

export async function nanobanana(prompt, opts = {}) {
    const {
        dimension = 'auto',
        aspect_ratio = 'auto',
        num_images = '1',
        size = '2K',
        resolution = '2K',
        output_format = 'png',
        turnstileToken = '',
    } = opts;

    const { session, cookieHeader } = await createAuthedSession();

    return createAndPollTask(session, cookieHeader, {
        prompt,
        dimension,
        aspect_ratio,
        image_urls: [],
        num_images,
        batchSize: 1,
        turnstileToken,
        skipVerification: false,
        image_path: 'hero',
        size,
        resolution,
        output_format,
    });
}

export async function nanoEditImage(imageUrl, prompt, opts = {}) {
    const {
        dimension = 'auto',
        aspect_ratio = 'auto',
        num_images = '1',
        size = '2K',
        resolution = '2K',
        output_format = 'png',
        turnstileToken = '',
    } = opts;

    const { session, cookieHeader } = await createAuthedSession();

    return createAndPollTask(session, cookieHeader, {
        prompt,
        dimension,
        aspect_ratio,
        image_urls: [imageUrl],
        num_images,
        batchSize: 1,
        turnstileToken,
        skipVerification: false,
        image_path: 'hero',
        size,
        resolution,
        output_format,
    });
}
