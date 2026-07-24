import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

/**
 * Upload file ke Discord Webhook (permanent)
 * @param {Buffer} buffer - Buffer file
 * @returns {Promise<string>} URL file
 */
async function uploadToDiscord(buffer) {
  const { ext, mime } = await fileTypeFromBuffer(buffer) || {};
  if (!ext || !mime) throw new Error('Tidak dapat menentukan tipe file');

  const form = new FormData();
  form.append('file', buffer, {
    filename: `file.${ext}`,
    contentType: mime
  });

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });

    const result = await response.json();
    console.log('Discord response:', result);

    if (result.attachments && result.attachments[0]) {
      return result.attachments[0].url;
    } else {
      throw new Error('Attachment tidak ditemukan dalam response');
    }
  } catch (error) {
    throw new Error(`Discord upload failed: ${error.message}`);
  }
}

export default async function upload(buffer, filename = 'file') {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Parameter harus berupa Buffer');
  }

  const fileType = await fileTypeFromBuffer(buffer);
  if (!fileType) {
    throw new Error('Tidak dapat menentukan tipe file');
  }

  const maxSize = 25 * 1024 * 1024; // Discord limit 25MB
  if (buffer.length > maxSize) {
    throw new Error(`Ukuran file terlalu besar: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB (max 25MB)`);
  }

  return await uploadToDiscord(buffer);
}