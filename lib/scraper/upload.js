import FormData from "form-data";
import axios from "axios";

/**
 * Upload buffer to Catbox
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export default async function upload(buffer) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", buffer, { filename: "file.bin" });
    try {
        const res = await axios.post("https://catbox.moe/user/api.php", form, {
            headers: form.getHeaders(),
        });
        return res.data.trim();
    } catch (err) {
        throw new Error("Upload Catbox gagal: " + err.message);
    }
}