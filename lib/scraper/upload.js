import FormData from "form-data";
import axios from "axios";

const LOCAL_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const LOCAL_UPLOAD_URL = `http://127.0.0.1:${LOCAL_PORT}/api/upload`;
const MAX_FILE_SIZE = 200 * 1024 * 1024;

const cache = new Map();

function getBufferHash(buffer) {
    return buffer.toString('base64').slice(0, 50);
}

async function uploadToLocal(buffer, filename) {
    const form = new FormData();
    form.append("file", buffer, { filename });
    
    const res = await axios.post(LOCAL_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000
    });

    if (!res.data?.success || !res.data?.url) {
        throw new Error(res.data?.message || "Upload failed");
    }

    return res.data.url;
}

export default async function upload(buffer, filename = "file.bin") {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("Invalid buffer");
    }

    if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
    }

    const hash = getBufferHash(buffer);
    
    if (cache.has(hash)) {
        return cache.get(hash);
    }

    const url = await uploadToLocal(buffer, filename);
    cache.set(hash, url);
    
    return url;
}