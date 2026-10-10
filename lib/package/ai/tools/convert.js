import { ctx, getContextInfo, AI_TMP_DIR } from '../mcp.js';
import { ZipFile, unzip, img2pdf } from '../../../utils/converter.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFile } from 'child_process';

const ROOT = process.cwd();
const MB = 1024 * 1024;
const MAX_SEND_BYTES = 200 * MB;
const MAX_ZIP_INPUT_BYTES = 300 * MB;
const MAX_ZIP_FILE_BYTES = 300 * MB;
const MAX_EXTRACT_TOTAL_BYTES = 800 * MB;
const MAX_EXTRACT_ENTRIES = 10000;
const MAX_MULTI_FILES = 40;
const MAX_ZIP_ENTRIES = 20000;
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const SEND_GAP_MS = 700;
const LISTING_LIMIT = 60;
const ALWAYS_SKIP_DIRS = new Set(['.git']);
const MODULE_DIR = 'node_modules';
const HOLDER_DIRS = new Set(['attached', 'converted', 'zips']);

const MIME = {
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
    json: 'application/json', csv: 'text/csv', xml: 'application/xml', js: 'text/javascript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', ico: 'image/x-icon', avif: 'image/avif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', '3gp': 'video/3gpp',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf', epub: 'application/epub+zip'
};
const EXT_BY_MIME = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/zip': 'zip', 'application/pdf': 'pdf',
    'application/x-zip-compressed': 'zip', 'text/plain': 'txt'
};
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'ico', 'avif', 'heic']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac', 'wma', 'amr']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', '3gp', 'flv']);
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const PANDOC_EXT = new Set(['md', 'markdown', 'html', 'htm', 'docx', 'odt', 'epub', 'rst', 'tex', 'txt']);
const PANDOC_OUT = new Set(['md', 'html', 'docx', 'odt', 'epub', 'rst', 'tex', 'txt']);
const TEXT_EXT = new Set([
    'txt', 'md', 'markdown', 'log', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini', 'conf', 'toml',
    'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'sql', 'css', 'lua', 'kt', 'swift'
]);
const PLAIN_EXT = new Set(['txt', 'log']);
const MD_EXT = new Set(['md', 'markdown']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
const fmtSize = (n) => n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const relPath = (p) => path.relative(ROOT, p) || '.';
const isInside = (child, parent) => {
    const r = path.relative(parent, child);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

function sanitizeName(name, fallback = 'file') {
    const clean = path.basename(String(name || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120);
    return clean || fallback;
}

function stripExt(name) {
    return name.slice(0, name.length - path.extname(name).length) || name;
}

function cleanTmp() {
    try {
        if (!fs.existsSync(AI_TMP_DIR)) return;
        const now = Date.now();
        const expired = (full) => {
            try { return now - fs.statSync(full).mtimeMs > TMP_MAX_AGE_MS; } catch { return false; }
        };
        for (const name of fs.readdirSync(AI_TMP_DIR)) {
            const full = path.join(AI_TMP_DIR, name);
            if (HOLDER_DIRS.has(name)) {
                for (const child of fs.readdirSync(full)) {
                    const childPath = path.join(full, child);
                    if (expired(childPath)) fs.rmSync(childPath, { recursive: true, force: true });
                }
            } else if (expired(full)) {
                fs.rmSync(full, { recursive: true, force: true });
            }
        }
    } catch (e) {
        console.warn('[convert] tmp cleanup failed:', e.message);
    }
}

function resolveAllowed(p) {
    const abs = path.resolve(ROOT, String(p || '').trim());
    if (!ctx().isOwner && !isInside(abs, AI_TMP_DIR)) {
        throw new Error('Only the bot owner may use paths outside data/ai/tmp.');
    }
    return abs;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function uniqueDir(base) {
    if (!fs.existsSync(base)) return base;
    for (let i = 2; i < 100; i++) {
        const candidate = `${base}-${i}`;
        if (!fs.existsSync(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
}

async function getAttachedMedia() {
    const c = ctx();
    const m = c.currentM;
    if (!m) return null;
    try {
        const { downloadMediaMessage } = await import('baileys');
        const types = ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];
        const direct = Object.keys(m.message || {}).find(t => types.includes(t));
        const info = getContextInfo(m);
        const quoted = info?.quotedMessage;
        const quotedType = quoted ? types.find(t => quoted[t]) : null;
        const type = direct || quotedType;
        if (!type) return null;
        const target = direct ? m : { message: quoted, key: { ...m.key, id: info?.stanzaId } };
        const buffer = await downloadMediaMessage(target, 'buffer', {});
        if (!buffer || !buffer.length) return null;
        const node = target.message?.[type] || {};
        const ext = EXT_BY_MIME[String(node.mimetype || '').split(';')[0]] || 'bin';
        const fileName = sanitizeName(node.fileName || `${type.replace('Message', '')}-${Date.now()}.${ext}`);
        return { buffer, fileName };
    } catch (e) {
        console.warn('[convert] could not read attached media:', e.message);
        return null;
    }
}

async function saveAttached() {
    const media = await getAttachedMedia();
    if (!media) return null;
    const dir = ensureDir(path.join(AI_TMP_DIR, 'attached'));
    const full = path.join(dir, `${Date.now()}-${media.fileName}`);
    fs.writeFileSync(full, media.buffer);
    return { full, fileName: media.fileName };
}

async function sendDoc(buffer, fileName, caption) {
    const c = ctx();
    if (!c.conn || !c.currentJid) throw new Error('WA connection not ready');
    if (buffer.length > MAX_SEND_BYTES) {
        throw new Error(`File is too large to send (${fmtSize(buffer.length)}, limit ${fmtSize(MAX_SEND_BYTES)}).`);
    }
    await c.conn.sendMessage(c.currentJid, {
        document: buffer,
        mimetype: MIME[extOf(fileName)] || 'application/octet-stream',
        fileName,
        ...(caption ? { caption } : {})
    }, { quoted: c.currentM });
}

function run(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * MB, ...options }, (err, stdout, stderr) => {
            if (err) {
                const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
                return reject(new Error(detail || 'command failed'));
            }
            resolve({ stdout, stderr });
        });
    });
}

const binCache = new Map();
async function hasBin(name) {
    if (binCache.has(name)) return binCache.get(name);
    let ok = false;
    try {
        await run('sh', ['-c', `command -v ${name}`]);
        ok = true;
    } catch (_) { }
    binCache.set(name, ok);
    return ok;
}
async function firstBin(names) {
    for (const n of names) {
        if (await hasBin(n)) return n;
    }
    return null;
}

function collectZipEntries(inputs) {
    const entries = [];
    const used = new Set();
    const state = { total: 0 };
    const uniqueName = (name) => {
        if (!used.has(name)) { used.add(name); return name; }
        const ext = path.posix.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        for (let i = 2; i < 10000; i++) {
            const candidate = `${stem}-${i}${ext}`;
            if (!used.has(candidate)) { used.add(candidate); return candidate; }
        }
        return name;
    };
    const addFile = (abs, name) => {
        const size = fs.statSync(abs).size;
        state.total += size;
        if (state.total > MAX_ZIP_INPUT_BYTES) throw new Error(`Input is too large to zip (limit ${fmtSize(MAX_ZIP_INPUT_BYTES)}).`);
        if (entries.length >= MAX_ZIP_ENTRIES) throw new Error(`Too many files to zip (limit ${MAX_ZIP_ENTRIES}).`);
        entries.push({ abs, name: uniqueName(name) });
    };
    const walk = (dirAbs, prefix, keepModules) => {
        for (const child of fs.readdirSync(dirAbs)) {
            const full = path.join(dirAbs, child);
            const st = fs.lstatSync(full);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                if (ALWAYS_SKIP_DIRS.has(child)) continue;
                if (child === MODULE_DIR && !keepModules) continue;
                walk(full, `${prefix}/${child}`, keepModules);
            } else if (st.isFile()) {
                addFile(full, `${prefix}/${child}`);
            }
        }
    };
    for (const input of inputs) {
        const label = path.basename(input) || 'root';
        const real = fs.realpathSync(input);
        const st = fs.statSync(real);
        const keepModules = input.split(path.sep).includes(MODULE_DIR) || real.split(path.sep).includes(MODULE_DIR);
        if (st.isDirectory()) walk(real, label, keepModules);
        else if (st.isFile()) addFile(real, label);
    }
    return { entries, total: state.total };
}

async function buildZipBuffer(entries) {
    const zip = new ZipFile();
    for (const e of entries) zip.file(e.name, fs.readFileSync(e.abs));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function inspectZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a valid zip file.');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
        total += buf.readUInt32LE(off + 24);
        off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    }
    return { count, total };
}

const HELV = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
    '{': 334, '|': 260, '}': 334, '~': 584
};
for (let d = 0; d <= 9; d++) HELV[String(d)] = 556;

const WINANSI = {
    '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94, '\u2013': 0x96, '\u2014': 0x97, '\u2022': 0x95, '\u2026': 0x85, '\u20AC': 0x80, '\u00A0': 0x20
};

function toWinAnsi(str) {
    let out = '';
    for (const ch of String(str).replace(/\t/g, '    ')) {
        const code = ch.codePointAt(0);
        if (WINANSI[ch]) out += String.fromCharCode(WINANSI[ch]);
        else if (code >= 32 && code < 127) out += ch;
        else if (code >= 160 && code <= 255) out += ch;
        else out += '?';
    }
    return out;
}

function charWidth(ch, font, size) {
    if (font === 'F3') return 0.6 * size;
    const w = (HELV[ch] ?? 556) / 1000 * size;
    return font === 'F2' ? w * 1.08 : w;
}

function wrapText(text, font, size, maxW) {
    if (font === 'F3') {
        const cols = Math.max(10, Math.floor(maxW / (0.6 * size)));
        if (!text.length) return [''];
        const out = [];
        for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
        return out;
    }
    const out = [];
    const spaceW = charWidth(' ', font, size);
    let cur = '';
    let curW = 0;
    for (const word of text.split(' ')) {
        let wordW = 0;
        for (const ch of word) wordW += charWidth(ch, font, size);
        if (wordW > maxW) {
            if (cur) { out.push(cur); cur = ''; curW = 0; }
            let piece = '';
            let pieceW = 0;
            for (const ch of word) {
                const w = charWidth(ch, font, size);
                if (pieceW + w > maxW) { out.push(piece); piece = ''; pieceW = 0; }
                piece += ch;
                pieceW += w;
            }
            cur = piece;
            curW = pieceW;
            continue;
        }
        const need = cur ? curW + spaceW + wordW : wordW;
        if (need > maxW) {
            out.push(cur);
            cur = word;
            curW = wordW;
        } else {
            cur = cur ? `${cur} ${word}` : word;
            curW = need;
        }
    }
    out.push(cur);
    return out;
}

const escPdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

class TextPdf {
    constructor() {
        this.W = 595;
        this.H = 842;
        this.M = 50;
        this.pages = [];
        this.ops = [];
        this.y = this.H - this.M;
    }
    newPage() {
        if (this.ops.length) this.pages.push(this.ops.join('\n'));
        this.ops = [];
        this.y = this.H - this.M;
    }
    line(text, font, size, leading, indent = 0) {
        if (this.y - leading < this.M) this.newPage();
        this.y -= leading;
        if (text) this.ops.push(`BT /${font} ${size} Tf ${this.M + indent} ${this.y.toFixed(2)} Td (${escPdf(text)}) Tj ET`);
    }
    gap(h) {
        this.y -= h;
        if (this.y < this.M) this.newPage();
    }
    block(text, font, size, leading, indent = 0) {
        const maxW = this.W - this.M * 2 - indent;
        for (const l of wrapText(toWinAnsi(text), font, size, maxW)) this.line(l, font, size, leading, indent);
    }
    addDocument(name, text, ext, showName) {
        if (showName) {
            this.gap(6);
            this.block(name, 'F2', 13, 17);
            this.gap(4);
        }
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        if (!PLAIN_EXT.has(ext) && !MD_EXT.has(ext)) {
            for (const l of lines) this.block(l, 'F3', 9, 11);
            return;
        }
        if (PLAIN_EXT.has(ext)) {
            for (const l of lines) this.block(l, 'F1', 11, 14);
            return;
        }
        let inCode = false;
        for (const raw of lines) {
            if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
            if (inCode) { this.block(raw, 'F3', 9, 11, 10); continue; }
            const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
            const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
            if (heading) {
                const size = [20, 17, 15, 13, 12, 11][heading[1].length - 1];
                this.gap(5);
                this.block(clean(heading[2]), 'F2', size, size + 4);
                this.gap(2);
            } else if (/^\s*[-*+]\s+/.test(raw)) {
                this.block(`\u2022 ${clean(raw.replace(/^\s*[-*+]\s+/, ''))}`, 'F1', 11, 14, 8);
            } else if (!raw.trim()) {
                this.gap(7);
            } else {
                this.block(clean(raw), 'F1', 11, 14);
            }
        }
    }
    finish() {
        if (this.ops.length || !this.pages.length) this.pages.push(this.ops.join('\n'));
        const objs = [];
        const add = (body) => {
            objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
            return objs.length;
        };
        add('<< /Type /Catalog /Pages 2 0 R >>');
        add('');
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
        const kids = [];
        for (const content of this.pages) {
            const data = zlib.deflateSync(Buffer.from(content, 'latin1'));
            const cid = add(Buffer.concat([
                Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
                data,
                Buffer.from('\nendstream', 'latin1')
            ]));
            const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${cid} 0 R >>`);
            kids.push(`${pid} 0 R`);
        }
        objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`, 'latin1');
        const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
        const offsets = [];
        let pos = chunks[0].length;
        objs.forEach((body, i) => {
            offsets.push(pos);
            const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
            chunks.push(part);
            pos += part.length;
        });
        let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
        for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
        xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
        chunks.push(Buffer.from(xref, 'latin1'));
        return Buffer.concat(chunks);
    }
}

function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n');
}

function textFilesToPdf(paths) {
    const pdf = new TextPdf();
    paths.forEach((p, i) => {
        if (i > 0) pdf.newPage();
        pdf.addDocument(path.basename(p), fs.readFileSync(p, 'utf-8'), extOf(p), paths.length > 1);
    });
    return pdf.finish();
}

async function officeConvert(inPath, to, outDir) {
    const bin = await firstBin(['soffice', 'libreoffice']);
    if (!bin) throw new Error('LibreOffice (soffice) is not installed on the server, so office documents cannot be converted.');
    const profile = path.join(AI_TMP_DIR, '.lo-profile');
    ensureDir(profile);
    await run(bin, [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', to, '--outdir', outDir, inPath]);
    const produced = path.join(outDir, `${path.basename(inPath, path.extname(inPath))}.${to.split(':')[0]}`);
    if (!fs.existsSync(produced)) throw new Error('LibreOffice finished but produced no output file.');
    return produced;
}

async function htmlToPdf(inPath, out) {
    if (await hasBin('wkhtmltopdf')) {
        await run('wkhtmltopdf', ['--quiet', '--enable-local-file-access', inPath, out]);
        return '';
    }
    const chrome = await firstBin(['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']);
    if (chrome) {
        await run(chrome, ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${out}`, `file://${inPath}`]);
        return '';
    }
    const pdf = new TextPdf();
    pdf.addDocument(path.basename(inPath), htmlToText(fs.readFileSync(inPath, 'utf-8')), 'txt', false);
    fs.writeFileSync(out, pdf.finish());
    return 'No HTML renderer (wkhtmltopdf/chromium) is installed, so the HTML was converted as plain text without layout.';
}

async function convertToPdf(paths, outDir, baseName) {
    const exts = paths.map(extOf);
    const out = path.join(outDir, `${baseName}.pdf`);
    if (exts.every(e => IMAGE_EXT.has(e))) {
        fs.writeFileSync(out, await img2pdf(paths));
        return { out, note: '' };
    }
    if (exts.every(e => TEXT_EXT.has(e))) {
        fs.writeFileSync(out, textFilesToPdf(paths));
        return { out, note: '' };
    }
    if (paths.length > 1) throw new Error('Multiple inputs for PDF must be all images or all text files. Convert HTML/office files one at a time.');
    if (exts[0] === 'html' || exts[0] === 'htm') return { out, note: await htmlToPdf(paths[0], out) };
    if (OFFICE_EXT.has(exts[0])) {
        const produced = await officeConvert(paths[0], 'pdf', outDir);
        if (produced !== out) fs.renameSync(produced, out);
        return { out, note: '' };
    }
    throw new Error(`Cannot convert .${exts[0] || 'unknown'} to PDF. Supported: images, text/code files, html, and office documents.`);
}

async function convertGeneric(inPath, to, outDir, outName) {
    const ext = extOf(inPath);
    const out = path.join(outDir, outName);
    if (TEXT_EXT.has(ext) && to === 'txt' && ext !== 'html') {
        fs.copyFileSync(inPath, out);
        return out;
    }
    if (IMAGE_EXT.has(ext) && IMAGE_EXT.has(to)) {
        const magick = await firstBin(['magick', 'convert']);
        if (magick) {
            await run(magick, [to === 'gif' || to === 'webp' ? inPath : `${inPath}[0]`, out]);
            return out;
        }
        if (await hasBin('ffmpeg')) {
            await run('ffmpeg', ['-y', '-i', inPath, out]);
            return out;
        }
        throw new Error('Neither ImageMagick nor ffmpeg is installed, so images cannot be converted.');
    }
    if ((AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) && (AUDIO_EXT.has(to) || VIDEO_EXT.has(to) || to === 'gif')) {
        if (!(await hasBin('ffmpeg'))) throw new Error('ffmpeg is not installed on the server, so audio/video cannot be converted.');
        const dropVideo = VIDEO_EXT.has(ext) && AUDIO_EXT.has(to);
        await run('ffmpeg', ['-y', '-i', inPath, ...(dropVideo ? ['-vn'] : []), out]);
        return out;
    }
    if (ext === 'pdf' && to === 'txt') {
        if (!(await hasBin('pdftotext'))) throw new Error('pdftotext (poppler-utils) is not installed on the server.');
        await run('pdftotext', ['-layout', inPath, out]);
        return out;
    }
    if (ext === 'pdf' && (to === 'png' || to === 'jpg')) {
        if (!(await hasBin('pdftoppm'))) throw new Error('pdftoppm (poppler-utils) is not installed on the server.');
        const prefix = path.join(outDir, stripExt(outName));
        await run('pdftoppm', [to === 'png' ? '-png' : '-jpeg', '-r', '150', '-f', '1', '-l', '1', '-singlefile', inPath, prefix]);
        return `${prefix}.${to}`;
    }
    if (PANDOC_EXT.has(ext) && PANDOC_OUT.has(to) && await hasBin('pandoc')) {
        await run('pandoc', [inPath, '-o', out]);
        return out;
    }
    if (OFFICE_EXT.has(ext) || OFFICE_EXT.has(to) || to === 'csv' || to === 'odt') {
        const produced = await officeConvert(inPath, to, outDir);
        if (produced !== out) fs.renameSync(produced, out);
        return out;
    }
    throw new Error(`Conversion from .${ext || 'unknown'} to .${to} is not supported (or the needed tool is not installed on the server).`);
}

async function resolveInputs(inputs) {
    const list = (Array.isArray(inputs) ? inputs : []).map(s => String(s || '').trim()).filter(Boolean);
    if (list.length) {
        return list.map(p => {
            const abs = resolveAllowed(p);
            if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
            if (fs.statSync(abs).isDirectory()) throw new Error(`${p} is a folder, not a file. Use create_zip for folders.`);
            return abs;
        });
    }
    const saved = await saveAttached();
    if (!saved) throw new Error('No input: pass "inputs" or attach/reply to a file.');
    return [saved.full];
}

export default [
    {
        name: 'create_zip',
        description: 'Pack files and/or whole folders into one .zip archive and send it to the user as a document. Use it whenever the user wants a folder or many files delivered together (e.g. "send me the whole plugins folder", "zip these files", "send all of lib/package/ai"). Folders are included recursively. When zipping a parent folder (e.g. the project root) the nested node_modules and .git folders are skipped automatically, but if a path itself points inside node_modules (e.g. \"node_modules/baileys\") that package is zipped normally, so installed libraries/modules CAN be sent: every installed package lives at node_modules/<package name>. Limits: ~300 MB of input, ~200 MB zip to send. Regular users can only zip things inside data/ai/tmp (e.g. extracted archives); the bot owner can zip any server path.',
        parameters: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Files and/or folders to include. Relative to the bot root or absolute.', required: true },
            file_name: { type: 'string', description: 'Name of the zip file, e.g. "ai-folder.zip" (optional, defaults to the first path name).', required: false },
            send: { type: 'boolean', description: 'Send the zip to the chat (default true). false = only save it under data/ai/tmp/zips and report the path.', required: false }
        },
        execute: async ({ paths, file_name, send = true } = {}) => {
            cleanTmp();
            try {
                if (!Array.isArray(paths) || !paths.length) return 'Failed: paths is required (at least one file or folder).';
                const inputs = paths.map(p => {
                    const abs = resolveAllowed(p);
                    if (!fs.existsSync(abs)) throw new Error(`Not found: ${p}`);
                    return abs;
                });
                const { entries, total } = collectZipEntries(inputs);
                if (!entries.length) return 'Failed: there are no files to zip (the folders are empty or only contain skipped items).';
                const buffer = await buildZipBuffer(entries);
                const base = sanitizeName(file_name ? stripExt(file_name) : path.basename(inputs[0]), 'archive');
                const name = `${base}.zip`;
                const dir = ensureDir(path.join(AI_TMP_DIR, 'zips'));
                const saved = path.join(dir, `${Date.now()}-${name}`);
                fs.writeFileSync(saved, buffer);
                if (!send) return `Zip saved: ${relPath(saved)} (${entries.length} files, ${fmtSize(total)} before compression, ${fmtSize(buffer.length)} zipped).`;
                await sendDoc(buffer, name);
                return `[ALREADY SENT] ${name} sent (${entries.length} files, ${fmtSize(buffer.length)}).`;
            } catch (e) {
                console.error('[create_zip] Error:', e);
                return `Failed: ${e.message}`;
            }
        }
    },
    {
        name: 'extract_zip',
        description: 'Extract a .zip archive into data/ai/tmp/<zip name>/ on the server. Use the zip the user attached or replied to (leave file_path empty), or a zip that already exists on the server. Returns the folder it was extracted to and a listing of its contents, so you can then read files, send some of them (send_multiple_files / send_as_file), or re-pack them (create_zip). Zip bombs and path traversal are blocked (max 10000 entries, ~800 MB uncompressed). Extracted folders are auto-deleted after 24 hours.',
        parameters: {
            file_path: { type: 'string', description: 'Path of a zip file on the server (optional). Leave empty to use the zip attached to / replied to in this message.', required: false },
            folder_name: { type: 'string', description: 'Folder name under data/ai/tmp to extract into (optional, defaults to the zip name without extension).', required: false }
        },
        execute: async ({ file_path, folder_name } = {}) => {
            cleanTmp();
            try {
                let buffer;
                let zipName;
                if (String(file_path || '').trim()) {
                    const abs = resolveAllowed(file_path);
                    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Failed: file not found: ${file_path}`;
                    if (fs.statSync(abs).size > MAX_ZIP_FILE_BYTES) return `Failed: zip is too large (limit ${fmtSize(MAX_ZIP_FILE_BYTES)}).`;
                    buffer = fs.readFileSync(abs);
                    zipName = path.basename(abs).replace(/^\d{10,}-/, '');
                } else {
                    const media = await getAttachedMedia();
                    if (!media) return 'Failed: no zip given. Attach/reply to a zip file or pass file_path.';
                    buffer = media.buffer;
                    zipName = media.fileName;
                }
                if (buffer.length > MAX_ZIP_FILE_BYTES) return `Failed: zip is too large (limit ${fmtSize(MAX_ZIP_FILE_BYTES)}).`;
                const info = inspectZip(buffer);
                if (info.count > MAX_EXTRACT_ENTRIES) return `Failed: zip has too many entries (${info.count}, limit ${MAX_EXTRACT_ENTRIES}).`;
                if (info.total > MAX_EXTRACT_TOTAL_BYTES) return `Failed: zip would expand to ${fmtSize(info.total)} (limit ${fmtSize(MAX_EXTRACT_TOTAL_BYTES)}).`;
                const folder = sanitizeName(folder_name || stripExt(zipName), 'extracted');
                const dest = uniqueDir(path.join(AI_TMP_DIR, folder));
                ensureDir(dest);
                const results = await unzip(buffer, { outputDir: dest });
                const files = results.filter(r => !r.isDirectory);
                const totalSize = files.reduce((s, r) => s + (r.size || 0), 0);
                const shown = files.slice(0, LISTING_LIMIT).map(r => `${r.name} (${fmtSize(r.size || 0)})`).join('\n');
                const more = files.length > LISTING_LIMIT ? `\n... and ${files.length - LISTING_LIMIT} more files` : '';
                return `[Listing for YOU TO READ/ANALYZE only — summarize it for the user in your own words, never paste it raw]\nExtracted ${files.length} files (${fmtSize(totalSize)}) from ${zipName} to ${relPath(dest)}\n${shown}${more}`;
            } catch (e) {
                console.error('[extract_zip] Error:', e);
                return `Failed: ${e.message}`;
            }
        }
    },
    {
        name: 'convert_file',
        description: 'Convert files to another format and send the result as a document. Input is one or more server files ("inputs") or, when empty, the file/image/audio/video attached to or replied to in this message. Supported targets: "pdf" (from images — several images become a multi-page PDF; from text/code/markdown/log/json/csv files, built in; from html and office documents docx/xlsx/pptx/odt when wkhtmltopdf/chromium/LibreOffice exist on the server); "zip" (packs the inputs); image to image (png/jpg/webp/gif/bmp/tiff, needs ImageMagick or ffmpeg); audio/video conversion such as mp4 to mp3 or wav to ogg (needs ffmpeg); documents such as md/html/docx/odt/epub/txt (needs pandoc or LibreOffice); pdf to txt/png/jpg (needs poppler-utils). If a needed tool is missing on the server, the result says so: tell the user plainly instead of retrying. Regular users can only use files inside data/ai/tmp or attached to the message; the owner can use any server path. Text PDFs use a built-in font, so non-Latin characters (e.g. emoji, CJK) become "?".',
        parameters: {
            to: { type: 'string', description: 'Target format without dot, e.g. "pdf", "zip", "png", "mp3", "docx", "txt".', required: true },
            inputs: { type: 'array', items: { type: 'string' }, description: 'Files to convert (relative to the bot root or absolute). Leave empty to use the file attached to / replied to in this message.', required: false },
            file_name: { type: 'string', description: 'Name for the output file (optional, defaults to the input name with the new extension).', required: false },
            send: { type: 'boolean', description: 'Send the result to the chat (default true). false = only save it under data/ai/tmp/converted and report the path.', required: false }
        },
        execute: async ({ to, inputs, file_name, send = true } = {}) => {
            cleanTmp();
            try {
                let target = String(to || '').toLowerCase().replace(/^\./, '').trim();
                if (target === 'jpeg') target = 'jpg';
                if (!target) return 'Failed: "to" (target format) is required.';
                const paths = await resolveInputs(inputs);
                const outDir = ensureDir(path.join(AI_TMP_DIR, 'converted', String(Date.now())));
                const firstBase = stripExt(path.basename(paths[0]).replace(/^\d{10,}-/, ''));
                const baseName = sanitizeName(file_name ? stripExt(file_name) : firstBase, 'converted');
                let out;
                let note = '';
                if (target === 'zip') {
                    const { entries } = collectZipEntries(paths);
                    out = path.join(outDir, `${baseName}.zip`);
                    fs.writeFileSync(out, await buildZipBuffer(entries));
                } else if (target === 'pdf') {
                    const res = await convertToPdf(paths, outDir, baseName);
                    out = res.out;
                    note = res.note;
                } else {
                    if (paths.length > 1) return 'Failed: this conversion accepts only one input file. Only PDF and ZIP accept several.';
                    out = await convertGeneric(paths[0], target, outDir, `${baseName}.${target}`);
                }
                const buffer = fs.readFileSync(out);
                const outName = path.basename(out);
                if (!send) return `Converted: ${relPath(out)} (${fmtSize(buffer.length)}).${note ? ` Note: ${note}` : ''}`;
                await sendDoc(buffer, outName);
                return `[ALREADY SENT] ${outName} sent (${fmtSize(buffer.length)}).${note ? ` Note: ${note}` : ''}`;
            } catch (e) {
                console.error('[convert_file] Error:', e);
                return `Failed: ${e.message}`;
            }
        }
    },
    {
        name: 'send_multiple_files',
        description: 'Send many files to the chat one by one as separate document attachments (up to 40 per call, with a short pause between them). Folders in the list are expanded to the files inside them (not recursive into node_modules/.git). Use it when the user wants several individual files, e.g. after extract_zip. If the user would rather have everything in a single archive or there are more than 40 files, use create_zip instead. Regular users can only send files inside data/ai/tmp; the owner can send any server path. Files over 100 MB are skipped.',
        parameters: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Files and/or folders to send. Relative to the bot root or absolute.', required: true },
            caption: { type: 'string', description: 'Optional caption attached to each file.', required: false }
        },
        execute: async ({ paths, caption } = {}) => {
            cleanTmp();
            try {
                if (!Array.isArray(paths) || !paths.length) return 'Failed: paths is required (at least one file or folder).';
                const files = [];
                const walk = (dir) => {
                    for (const child of fs.readdirSync(dir).sort()) {
                        const full = path.join(dir, child);
                        const st = fs.lstatSync(full);
                        if (st.isSymbolicLink()) continue;
                        if (st.isDirectory()) {
                            if (!ALWAYS_SKIP_DIRS.has(child) && child !== MODULE_DIR) walk(full);
                        } else if (st.isFile()) {
                            files.push(full);
                        }
                    }
                };
                for (const p of paths) {
                    const abs = resolveAllowed(p);
                    if (!fs.existsSync(abs)) throw new Error(`Not found: ${p}`);
                    const st = fs.lstatSync(abs);
                    if (st.isDirectory()) walk(abs);
                    else if (st.isFile()) files.push(abs);
                }
                if (!files.length) return 'Failed: no files found to send.';
                if (files.length > MAX_MULTI_FILES) return `Failed: ${files.length} files is too many for one call (limit ${MAX_MULTI_FILES}). Use create_zip to send them as one archive.`;
                let sent = 0;
                const skipped = [];
                for (const file of files) {
                    try {
                        const size = fs.statSync(file).size;
                        if (size > 100 * MB) { skipped.push(`${path.basename(file)} (too large)`); continue; }
                        if (!size) { skipped.push(`${path.basename(file)} (empty)`); continue; }
                        await sendDoc(fs.readFileSync(file), path.basename(file), caption);
                        sent++;
                        await sleep(SEND_GAP_MS);
                    } catch (e) {
                        skipped.push(`${path.basename(file)} (${e.message.slice(0, 40)})`);
                    }
                }
                const skipNote = skipped.length ? ` Skipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}.` : '';
                return `[ALREADY SENT] Sent ${sent} of ${files.length} files.${skipNote}`;
            } catch (e) {
                console.error('[send_multiple_files] Error:', e);
                return `Failed: ${e.message}`;
            }
        }
    }
];
