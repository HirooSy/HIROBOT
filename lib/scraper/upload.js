import FormData from "form-data";
import axios from "axios";

// Primary: onlyfiles.com — anonymous upload, no account/API key required.
// Fallback: the bot's own local file server (see lib/server.js,
// route POST /api/upload) in case onlyfiles.com is unreachable.
const ONLYFILES_UPLOAD_URL = "https://api.onlyfiles.com/v1/upload";

const LOCAL_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const LOCAL_UPLOAD_URL = `http://127.0.0.1:${LOCAL_PORT}/api/upload`;

async function uploadToOnlyfiles(buffer, filename) {
    const form = new FormData();
    form.append("file", buffer, { filename });
    // expire=0 = "Forever" option on onlyfiles.com (confirmed from upload payload)
    form.append("expire", "0");
    const res = await axios.post(ONLYFILES_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000,
        validateStatus: () => true, // inspect error bodies instead of throwing generic errors
    });
    if (res.status !== 200) {
        throw new Error(`onlyfiles.com HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    // onlyfiles.com returns { status: true, data: { file: { url: { full, short }, metadata: {...} } } }
    const data = res.data?.data?.file;
    if (res.data?.status !== true || !data) {
        throw new Error(res.data?.message || "onlyfiles.com returned no file data");
    }
    const shareUrl = data.url?.full || data.url?.short;
    if (!shareUrl) {
        throw new Error("onlyfiles.com returned no share URL");
    }

    // The JSON response only gives the HTML share/preview page URL.
    // The real direct download link (e.g. .../dl/{ts}.{hash}/{code}/{filename})
    // is only present inside that page's HTML, so fetch it and extract it.
    try {
        const pageRes = await axios.get(shareUrl, { timeout: 15000 });
        const html = typeof pageRes.data === "string" ? pageRes.data : "";
        const match = html.match(/<a class="download" href="([^"]+)"/);
        if (match?.[1]) {
            return match[1];
        }
    } catch (e) {
        console.error("[UPLOAD] onlyfiles.com: failed to fetch share page for direct link:", e.message);
    }

    // Fallback: return the share page URL if direct-link extraction failed.
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

/**
 * Upload a buffer, preferring onlyfiles.com (no account/key needed). Falls
 * back to the bot's own local file server if onlyfiles.com is unreachable.
 * @param {Buffer} buffer
 * @param {string} [filename] - original filename (extension preserved)
 * @returns {Promise<string>} public URL
 */
export default async function upload(buffer, filename = "file.bin") {
    try {
        return await uploadToOnlyfiles(buffer, filename);
    } catch (err) {
        console.error("[UPLOAD] onlyfiles.com failed, falling back to local server:", err.message);
        try {
            return await uploadToLocal(buffer, filename);
        } catch (err2) {
            throw new Error("Upload failed on all providers: " + err2.message);
        }
    }
}
