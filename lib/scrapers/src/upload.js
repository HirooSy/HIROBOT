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

// Uses the native global `FormData` + `fetch` (both built into Node.js) instead of the
// `form-data` package + axios for these two multipart uploads specifically — axios has no
// first-class support for the native FormData's auto-generated boundary/headers, while fetch
// does this natively. axios is still used elsewhere in this file for the plain GET follow-up.
async function uploadToOnlyfiles(buffer, filename) {
    const form = new FormData();
    form.append("file", new Blob([buffer]), filename);
    form.append("expire", "0");
    const res = await fetch(ONLYFILES_UPLOAD_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
    });
    const bodyText = await res.text();
    let data;
    try {
        data = JSON.parse(bodyText);
    } catch {
        data = undefined;
    }
    if (res.status !== 200) {
        throw new Error(`onlyfiles.com HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    const fileData = data?.data?.file;
    if (data?.status !== true || !fileData) {
        throw new Error(data?.message || "onlyfiles.com returned no file data");
    }
    const shareUrl = fileData.url?.full || fileData.url?.short;
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
    form.append("file", new Blob([buffer]), filename);
    const res = await fetch(LOCAL_UPLOAD_URL, { method: "POST", body: form });
    const data = await res.json().catch(() => undefined);
    if (!data?.success || !data?.url) {
        throw new Error(data?.message || "Local upload server returned no URL");
    }
    return data.url;
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
