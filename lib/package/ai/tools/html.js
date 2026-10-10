import { ctx } from '../mcp.js';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const MAX_HTML_CHARS = 200_000;
const OFFER_COOLDOWN_MS = 20 * 60 * 1000;
const STORE_TTL_MS = 6 * 60 * 60 * 1000;
const STORE_MAX_ENTRIES = 50;

const lastHtmlByChat = new Map();
const lastOfferByChat = new Map();

function cleanHtml(raw) {
    let s = String(raw || '').trim();
    const fence = /^```(?:html)?\s*\n([\s\S]*?)\n?```$/i.exec(s);
    if (fence) s = fence[1].trim();
    return s;
}

function ensureDocument(html) {
    if (/<html[\s>]/i.test(html)) return html;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font-family: system-ui, sans-serif; background: transparent; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function remember(jid, html, title) {
    const now = Date.now();
    for (const [key, entry] of lastHtmlByChat) {
        if (now - entry.at > STORE_TTL_MS) lastHtmlByChat.delete(key);
    }
    lastHtmlByChat.delete(jid);
    lastHtmlByChat.set(jid, { html, title: title || '', at: now });
    while (lastHtmlByChat.size > STORE_MAX_ENTRIES) {
        lastHtmlByChat.delete(lastHtmlByChat.keys().next().value);
    }
}

function shouldOfferFile(jid) {
    const last = lastOfferByChat.get(jid) || 0;
    if (Date.now() - last < OFFER_COOLDOWN_MS) return false;
    lastOfferByChat.set(jid, Date.now());
    return true;
}

function safeFileName(name, title) {
    const base = String(name || title || 'design')
        .trim()
        .replace(/\.html?$/i, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return `${base || 'design'}.html`;
}

async function renderInChat({ html, title }) {
    const c = ctx();
    if (!c.conn || !c.currentJid) return { error: 'WA connection not ready' };
    const body = cleanHtml(html);
    if (!body) return { error: 'html is empty' };
    if (body.length > MAX_HTML_CHARS) {
        return { error: `HTML is too large (${body.length} chars, limit ${MAX_HTML_CHARS}). Make it more compact (less repeated markup, no embedded images) and call the tool again.` };
    }
    const doc = ensureDocument(body);
    try {
        const rich = c.conn.aiRich();
        if (title) rich.setTitle(String(title).slice(0, 80));
        rich.addHtml(doc);
        await rich.send(c.currentJid, { quoted: c.currentM });
    } catch (e) {
        console.error('[html] aiRich send failed:', e);
        return { error: `Failed to render the HTML in chat: ${e.message}` };
    }
    remember(c.currentJid, doc, title);
    return { doc, jid: c.currentJid };
}

function deliveredMessage(kind, jid) {
    const offer = shouldOfferFile(jid) ? 'yes' : 'no';
    return `[ALREADY SENT] ${kind} rendered in chat. offer_file=${offer}`;
}

export default [
    {
        name: 'html_design',
        description: 'Design a visual page, UI or graphic and render it live inside the WhatsApp chat (AI Rich HTML). Use it when the user asks you to design or build something visual: landing page, profile or business card, poster, invitation, certificate, menu, dashboard, infographic, resume, pricing table, form mockup, small interactive widget or mini game, etc. YOU write the complete HTML and pass it in "html" — the tool only renders it, so do not paste the code into your reply. The tool result tells you whether to ask the user about getting the .html file.\n\nDESIGN RULES (follow all of them):\n1. Deliver ONE self-contained document. Put all CSS in a <style> block and any JavaScript inline in a <script> block. No external CSS, JS, fonts, images or CDN links (they are blocked or unreliable in the chat renderer). Use inline SVG, CSS gradients, emoji and data: URIs for visuals.\n2. Mobile-first. Include <meta name="viewport" content="width=device-width, initial-scale=1">. Design for a 360-420px wide screen, use fluid widths, max-width: 100%, flexbox or grid, and never cause horizontal scrolling.\n3. Support light and dark mode: add :root { color-scheme: light dark; }, define colors as CSS variables, override them in @media (prefers-color-scheme: dark), and keep the body background transparent or a deliberate surface color.\n4. Visual quality: clear hierarchy, one accent color plus neutrals, a consistent spacing scale, 16px base text with 1.5 line height, rounded corners, enough contrast, short copy instead of walls of text, and a system font stack.\n5. Keep it compact: aim for under ~20KB unless the user asks for something complex. Hard limit is 200KB.\n6. Interactivity only when it helps and only with vanilla JS. No network requests and no forms that submit anywhere.\n7. Write the visible text of the design in the language the user is using, unless they ask otherwise.\n8. If the user asked for changes to a previous design, apply them to the previous HTML and render the full updated page again.',
        parameters: {
            html: { type: 'string', description: 'The complete HTML document (or just the body markup plus <style>) for the design. Raw HTML only, no markdown fences.', required: true },
            title: { type: 'string', description: 'Short title shown above the rendered design (optional, e.g. "Coffee Shop Landing Page").', required: false }
        },
        execute: async ({ html, title } = {}) => {
            const res = await renderInChat({ html, title });
            if (res.error) return `Failed: ${res.error}`;
            return deliveredMessage('HTML design', res.jid);
        }
    },
    {
        name: 'html_preview',
        description: 'Render EXISTING HTML inside the WhatsApp chat so the user can see how it looks (AI Rich HTML). Use it for requests like "preview this html", "show me how this renders", "render this code", "open this html file". Pass the HTML exactly as the user gave it: do not redesign, restyle or "fix" it unless the user asks for that (if they ask for a redesign, use html_design instead). Provide either "html" (code pasted by the user or taken from a replied message) or "file_path" (an HTML file on the server, bot owner only). Do not paste the HTML back into your reply. The tool result tells you whether to ask the user about getting the .html file.',
        parameters: {
            html: { type: 'string', description: 'The HTML to preview, exactly as provided by the user. Raw HTML only, no markdown fences. Leave empty when using file_path.', required: false },
            file_path: { type: 'string', description: 'Path of an HTML file on the server, relative to the bot root or absolute. Bot owner only. Leave empty when using html.', required: false },
            title: { type: 'string', description: 'Short title shown above the preview (optional, defaults to the file name when file_path is used).', required: false }
        },
        execute: async ({ html, file_path, title } = {}) => {
            let source = html;
            let label = title;
            if (!String(source || '').trim() && file_path) {
                if (!ctx().isOwner) return 'file_path can only be used by the bot owner. Ask the user to paste the HTML code instead.';
                const abs = path.resolve(ROOT, file_path);
                if (!fs.existsSync(abs)) return `File not found: ${file_path}`;
                if (fs.statSync(abs).isDirectory()) return `${file_path} is a directory, not a file.`;
                source = fs.readFileSync(abs, 'utf-8');
                label = label || path.basename(abs);
            }
            if (!String(source || '').trim()) return 'Nothing to preview: pass the HTML in "html" or an existing file in "file_path".';
            const res = await renderInChat({ html: source, title: label });
            if (res.error) return `Failed: ${res.error}`;
            return deliveredMessage('HTML preview', res.jid);
        }
    },
    {
        name: 'send_html_file',
        description: 'Send the HTML that was most recently rendered in this chat (by html_design or html_preview) as a downloadable .html document attachment. Call it when the user says yes to your offer of the html file, or explicitly asks for the HTML file/source of the design or preview you just showed. The HTML is read from memory by the tool, so never retype it. Do not call it on your own initiative without the user asking or agreeing.',
        parameters: {
            file_name: { type: 'string', description: 'File name for the attachment (optional, e.g. "landing-page.html"). Defaults to a name based on the title.', required: false }
        },
        execute: async ({ file_name } = {}) => {
            const c = ctx();
            if (!c.conn || !c.currentJid) return 'WA connection not ready';
            const entry = lastHtmlByChat.get(c.currentJid);
            if (!entry || Date.now() - entry.at > STORE_TTL_MS) {
                return 'There is no recent HTML for this chat. Create one first with html_design or html_preview.';
            }
            const fileName = safeFileName(file_name, entry.title);
            try {
                await c.conn.sendMessage(c.currentJid, {
                    document: Buffer.from(entry.html, 'utf-8'),
                    mimetype: 'text/html',
                    fileName
                }, { quoted: c.currentM });
            } catch (e) {
                console.error('[send_html_file] Error:', e);
                return `Failed to send the file: ${e.message}`;
            }
            lastOfferByChat.set(c.currentJid, Date.now());
            return `[ALREADY SENT] HTML file ${fileName} sent.`;
        }
    }
];
