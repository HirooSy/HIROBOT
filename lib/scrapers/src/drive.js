import axios from 'hiro/axios';

function extractDriveId(url) {
    let m = url.match(/\/d\/([\w-]+)/);
    if (m) return { id: m[1], type: 'drive' };
    m = url.match(/[?&]id=([\w-]+)/);
    if (m) return { id: m[1], type: 'drive' };
    m = url.match(/\/videos\/d\/([\w-]+)/);
    if (m) return { id: m[1], type: 'docs_video' };
    return null;
}

function isGdriveUrl(text) {
    try {
        const u = new URL(text.trim());
        return ['drive.google.com', 'docs.google.com'].includes(u.hostname);
    } catch { return false; }
}

async function gdrive(url) {
    const extracted = extractDriveId(url);
    if (!extracted) return { status: false, error: 'Invalid Google Drive URL.' };

    const { id, type } = extracted;

    if (type === 'docs_video') {
        return { status: false, error: 'Videos uploaded to Google Docs/Slides cannot be downloaded — Google requires a login to access them. Ask the sender to upload it again to regular Google Drive.' };
    }

    try {
        const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

        const res = await axios.get(downloadUrl, {
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            },
            responseType: 'stream',
            maxRedirects: 5,
            timeout: 10000
        });
        res.data.destroy();

        if (res.status !== 200) throw new Error(`Server returned ${res.status}`);

        const disposition = res.headers['content-disposition'] || '';
        const nameMatch = disposition.match(/filename="?([^"]+)"?/);
        const fileName = nameMatch ? nameMatch[1] : `file_${id}`;
        const mimetype = res.headers['content-type'] || 'application/octet-stream';
        const sizeBytes = parseInt(res.headers['content-length'] || '0');

        return {
            status: true,
            fileName,
            fileSize: sizeBytes ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : 'Unknown',
            mimetype,
            extension: fileName.split('.').pop().toLowerCase(),
            downloadUrl
        };
    } catch (err) {
        return { status: false, error: err.message };
    }
}

export { isGdriveUrl, gdrive }
