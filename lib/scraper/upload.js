import FormData from "form-data";
import axios from "axios";

const LOCAL_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const LOCAL_UPLOAD_URL = `http://127.0.0.1:${LOCAL_PORT}/api/upload`;

// Cache untuk menyimpan URL berdasarkan hash buffer
const cache = new Map();

/**
 * Buat hash sederhana dari buffer
 */
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
        throw new Error(res.data?.message || "Upload gagal");
    }

    return res.data.url;
}

export default async function upload(buffer, filename = "file.bin") {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("Buffer tidak valid");
    }

    // Buat hash dari buffer
    const hash = getBufferHash(buffer);
    
    // Cek apakah buffer sudah pernah diupload
    if (cache.has(hash)) {
        return cache.get(hash); // Kembalikan URL yang sudah ada
    }

    // Upload baru dan simpan ke cache
    const url = await uploadToLocal(buffer, filename);
    cache.set(hash, url);
    
    return url;
}