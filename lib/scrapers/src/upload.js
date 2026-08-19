import FormData from "form-data";
import axios from "axios";
import crypto from "crypto";

const ONLYFILES_UPLOAD_URL = "https://api.onlyfiles.com/v1/upload";
const ONLYFILES_MAX_SIZE = 100 * 1024 * 1024;
const LOCAL_MAX_SIZE = 200 * 1024 * 1024;

const LOCAL_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const LOCAL_UPLOAD_URL = `http://127.0.0.1:${LOCAL_PORT}/api/upload`;

const uploadCache = new Map();

function hashBuffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function uploadToOnlyfiles(buffer, filename) {
    const form = new FormData();
    form.append("file", buffer, { filename });
    form.append("expire", "0");
    const res = await axios.post(ONLYFILES_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000,
        validateStatus: () => true,
    });
    if (res.status !== 200) {
        throw new Error(`onlyfiles.com HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    const data = res.data?.data?.file;
    if (res.data?.status !== true || !data) {
        throw new Error(res.data?.message || "onlyfiles.com returned no file data");
    }
    const shareUrl = data.url?.full || data.url?.short;
    if (!shareUrl) {
        throw new Error("onlyfiles.com returned no share URL");
    }

    try {
        const pageRes = await axios.get(shareUrl, { timeout: 15000 });
        const html = typeof pageRes.data === "string" ? pageRes.data : "";
        const match = html.match(/<a class="download" href="([^"]+)"/);
        if (match?.[1]) {
            return match[1];
        }
    } catch (e) {
        console.error("[UPLOAD] onlyfiles.com:", e.message);
    }

    return shareUrl;
}

async function uploadToLocal(buffer, filename) {
    const form = new FormData();
    form.append("file", buffer, { filename });
    const res = await axios.post(LOCAL_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });
    if (!res.data?.success || !res.data?.url) {
        throw new Error(res.data?.message || "Local upload server returned no URL");
    }
    return res.data.url;
}

export default async function upload(buffer, filename = "file.bin") {
    const hash = hashBuffer(buffer);
    const cached = uploadCache.get(hash);
    if (cached) {
        return cached;
    }

    if (buffer.length > LOCAL_MAX_SIZE) {
        throw new Error(`File too large: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB exceeds max limit of ${LOCAL_MAX_SIZE / (1024 * 1024)}MB`);
    }

    let url;
    if (buffer.length <= ONLYFILES_MAX_SIZE) {
        try {
            url = await uploadToOnlyfiles(buffer, filename);
        } catch (err) {
            console.error("[UPLOAD] onlyfiles.com failed, falling back to local server:", err.message);
        }
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
