import crypto from "crypto";

const SAVEDLY_UPLOAD_URL = "https://savedly.net/api/upload";
const SAVEDLY_CDN_BASE = "https://cdn.savedly.net";

const LOCAL_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const LOCAL_UPLOAD_URL = `http://127.0.0.1:${LOCAL_PORT}/api/upload`;
const LOCAL_MAX_SIZE = 200 * 1024 * 1024;

// Cache hanya di memori proses. Hilang saat bot restart.
const uploadCache = new Map();

function hashBuffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function uploadToSavedly(buffer, filename) {
    const res = await fetch(SAVEDLY_UPLOAD_URL, {
        method: "POST",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Origin": "https://savedly.net",
            "Referer": "https://savedly.net/",
            "X-Filename": filename,
        },
        body: new Blob([buffer], { type: "application/octet-stream" }),
        signal: AbortSignal.timeout(120000),
    });

    const text = (await res.text()).trim();
    if (!res.ok) {
        throw new Error(`savedly HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = undefined;
    }

    const source = data?.url || data?.link || data?.file || text;
    const id = data?.id || String(source).match(/\/f\/([a-z0-9]+)/i)?.[1];
    if (!id) {
        throw new Error(`savedly returned unexpected response: ${text.slice(0, 300)}`);
    }

    return `${SAVEDLY_CDN_BASE}/${id}`;
}

async function uploadToLocal(buffer, filename) {
    const form = new FormData();
    form.append("file", new Blob([buffer]), filename);

    const res = await fetch(LOCAL_UPLOAD_URL, { method: "POST", body: form });
    const data = await res.json().catch(() => undefined);
    if (!data?.success || !data?.url) {
        throw new Error(data?.message || "Local upload server returned no URL");
    }
    return data.url;
}

export default async function upload(buffer, filename = "file.bin") {
    if (buffer.length > LOCAL_MAX_SIZE) {
        throw new Error(`File too large: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB exceeds max limit of ${LOCAL_MAX_SIZE / (1024 * 1024)}MB`);
    }

    const hash = hashBuffer(buffer);
    const cached = uploadCache.get(hash);
    if (cached) {
        return cached;
    }

    let url;
    try {
        url = await uploadToSavedly(buffer, filename);
    } catch (err) {
        console.error("[UPLOAD] savedly failed, falling back to local server:", err.message);
    }

    if (!url) {
        try {
            url = await uploadToLocal(buffer, filename);
        } catch (err2) {
            throw new Error("Upload failed on all providers: " + err2.message);
        }
    }

    uploadCache.set(hash, url);
    return url;
}