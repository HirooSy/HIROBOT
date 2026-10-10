import { ctx, buildSimpleDiff, readFileToolCore, appendAutoHealStatus, AI_BACKUP_DIR } from '../mcp.js';
import fs from 'fs';
import path from 'path';
const ROOT = process.cwd();
export default [
    {
        name: 'read_file',
        description: 'Read the content of a file on the server. Can read config, plugins, .env, etc. For JSON files (package.json, config.json, etc), it parses and displays them in a tidier format. For VERY LARGE files (more than ~100k characters), the content is cut into parts — use the offset parameter to get the next part (see the [FILE TRUNCATED] note in the response when this happens). If the given path is not found EXACTLY, this tool automatically searches for files with a similar name across the whole project and offers the choices through buttons — you do NOT need to try other paths yourself by trial and error, just call this tool and let it do the searching.',
        parameters: {
            file_path: { type: 'string', description: 'File path. May be RELATIVE to the bot root (example: "plugins/ai.js", "package.json") OR ABSOLUTE starting with "/" (example: "/etc/hosts", "/var/log/syslog") to read a file ANYWHERE on the server, not limited to the project folder. May also be just a file name without a folder (e.g. "profile.js") — this tool will find its location inside the project by itself if it is not found at the root.', required: true },
            offset: { type: 'number', description: 'Character position to start reading from (default 0). Used to get the next part of a large file that was cut off — fill it with the number mentioned in the [FILE TRUNCATED] note from the previous read_file call.', required: false }
        },
        execute: async ({ file_path, offset = 0 }) => {
            const abs = path.resolve(ROOT, file_path);
            if (!fs.existsSync(abs)) {
                const wantedName = path.basename(file_path).toLowerCase();
                const matches = [];
                const skipDirs = new Set(['node_modules', '.git', 'sessions', 'tmp']);
                const walk = (dir, depth = 0) => {
                    if (depth > 6 || matches.length >= 8)
                        return;
                    let entries;
                    try {
                        entries = fs.readdirSync(dir, { withFileTypes: true });
                    }
                    catch (_) {
                        return;
                    }
                    for (const ent of entries) {
                        if (matches.length >= 8)
                            return;
                        if (ent.isDirectory()) {
                            if (skipDirs.has(ent.name))
                                continue;
                            walk(path.join(dir, ent.name), depth + 1);
                        }
                        else if (ent.name.toLowerCase() === wantedName) {
                            matches.push(path.relative(ROOT, path.join(dir, ent.name)));
                        }
                    }
                };
                walk(ROOT);
                if (matches.length === 1) {
                    return await readFileToolCore(matches[0], offset);
                }
                if (matches.length > 1) {
                    const btnList = matches.slice(0, 8).map(m => ({ type: 'reply', label: m.length > 24 ? '…' + m.slice(-23) : m, value: `read file ${m}` }));
                    return `File "${file_path}" was not found exactly. Found ${matches.length} candidates with the same name: ${matches.slice(0, 8).join(', ')}.\n\n` +
                        `Offer these choices to the user through buttons — reply with this JSON __type:"buttons" AS THE ONLY CONTENT OF YOUR RESPONSE (no other text outside the JSON):\n` +
                        JSON.stringify({ __type: 'buttons', body: `File "${file_path}" was not found exactly. Which one is it?`, buttons: btnList });
                }
                return `File not found: ${file_path} (also searched the whole project, no file named "${wantedName}")`;
            }
            return await readFileToolCore(file_path, offset);
        }
    },
    {
        name: 'write_file',
        description: 'Write/overwrite the content of a file on the server. It automatically makes a backup before overwriting. NEVER use this tool for requests like "send/show/let me see the content of file X" — those MUST use read_file followed by send_codeblock/send_as_file (this tool does NOT send anything to the chat, it only writes to the server disk). write_file is ONLY for when the user explicitly asks to CHANGE/EDIT the content of a file (e.g. "change the version in package.json to 2.0", "add function X to file Y"). Misusing this tool just to "display" a file has once really overwritten the user\'s original file with a wrong/shorter version — ALWAYS make sure the content you write is EXACTLY what the user wants, do NOT rewrite from your own memory/assumptions. THIS PROJECT IS PURE ESM: for .js/.mjs files, NEVER use require() — always "import x from \'y\'" at the top of the file, or "const x = (await import(\'y\')).default" for a dynamic import. This tool will REFUSE to write a .js/.mjs file that still contains require().',
        parameters: {
            file_path: { type: 'string', description: 'File path. May be RELATIVE to the bot root OR ABSOLUTE starting with "/" to write to any file on the server (not limited to the project folder) — be careful when writing outside the project, make sure it is really what the user asked for.', required: true },
            content: { type: 'string', description: 'The file content to write', required: true }
        },
        execute: async ({ file_path, content }) => {
            const abs = path.resolve(ROOT, file_path);
            const isEsmModule = /\.(m?js)$/i.test(file_path) && !file_path.endsWith('.cjs');
            if (isEsmModule) {
                // Match require( calls that are actual CommonJS usage, not
                // substring hits inside comments/strings mentioning the word
                // — still permissive on purpose (e.g. skip content inside
                // backtick template literals is NOT attempted here, keep it
                // simple: any executable require( call is disallowed since
                // this project has no CJS files at all).
                const requireMatch = content.match(/\brequire\s*\(\s*['"`]/);
                if (requireMatch) {
                    const lineNum = content.slice(0, requireMatch.index).split('\n').length;
                    return `REJECTED: ${file_path} still uses require() at line ~${lineNum} — this project is pure ESM ` +
                        `(see CODE_CONVENTIONS), every import MUST use "import x from 'y'" at the top of the file, ` +
                        `or "const x = (await import('y')).default" if you need a dynamic import (e.g. inside a function, ` +
                        `or when the import is conditional). Fix it into an ESM import first, then call write_file again. ` +
                        `write_file writes NOTHING to disk as long as a .js/.mjs file still contains require().`;
                }
            }
            const existed = fs.existsSync(abs);
            const oldContent = existed ? fs.readFileSync(abs, 'utf-8') : '';
            if (existed && oldContent.length > 200) {
                const shrinkRatio = 1 - (content.length / oldContent.length);
                if (shrinkRatio > 0.2) {
                    const diff = buildSimpleDiff(oldContent, content);
                    if (ctx().autoHealActive && ctx().autoHealNotifyJid && ctx().conn) {
                        await appendAutoHealStatus(`*Auto-Heal CANCELLED* for ${file_path}\n\n` +
                            `The change would shrink the file from ${oldContent.length} → ${content.length} chars ` +
                            `(${Math.round(shrinkRatio * 100)}% shorter). This is the same pattern as an earlier incident ` +
                            `(important logic silently removed), so it was rejected automatically and needs manual review.\n\n` +
                            `Diff (summary):\n${diff.slice(0, 1500)}`);
                    }
                    return `REJECTED: change would shrink ${file_path} by ${Math.round(shrinkRatio * 100)}% ` +
                        `(${oldContent.length} → ${content.length} chars). This is usually a sign that content/logic was removed ` +
                        `unintentionally (e.g. the AI rewrote it from its own memory instead of copying the original content), not a ` +
                        `normal edit. If the file SHOULD really become shorter (e.g. a deliberate refactor/removal of dead code), ` +
                        `explain the reason explicitly to the user and ask for confirmation first before ` +
                        `calling write_file again — a file this large will not be overwritten automatically.`;
                }
            }
            if (existed) {
                const backupDir = AI_BACKUP_DIR;
                fs.mkdirSync(backupDir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupName = file_path.replace(/[/\\]/g, '__') + '.' + stamp + '.bak';
                fs.copyFileSync(abs, path.join(backupDir, backupName));
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf-8');
            if (ctx().autoHealActive && ctx().autoHealNotifyJid && ctx().conn && existed) {
                const diff = buildSimpleDiff(oldContent, content);
                await appendAutoHealStatus(`Wrote ${file_path} (${oldContent.length} -> ${content.length} chars)\n\nDiff:\n${diff.slice(0, 1500)}`);
            }
            return `Written: ${file_path} (${content.length} chars)`;
        }
    },
    {
        name: 'list_files',
        description: 'List the content of a folder on the server. Can be used for any folder across the whole system, not limited to the bot project folder.',
        parameters: {
            dir_path: { type: 'string', description: 'Folder path. RELATIVE to the bot root (default: "." = project root) OR ABSOLUTE starting with "/" (example: "/", "/etc", "/home") to list any directory on the server.', required: false }
        },
        execute: async ({ dir_path = '.' }) => {
            const abs = path.resolve(ROOT, dir_path);
            if (!fs.existsSync(abs))
                return `Folder not found: ${dir_path}`;
            const entries = fs.readdirSync(abs, { withFileTypes: true });
            const list = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
            return `${dir_path}:\n${list}`;
        }
    },
    {
        name: 'delete_file',
        description: 'Delete a file from the server.',
        parameters: {
            file_path: { type: 'string', description: 'Path of the file to delete. RELATIVE to the bot root OR ABSOLUTE starting with "/" to delete any file on the server. BE CAREFUL outside the project — make sure the user really asked for it.', required: true }
        },
        execute: async ({ file_path }) => {
            const abs = path.resolve(ROOT, file_path);
            if (!fs.existsSync(abs))
                return `File not found: ${file_path}`;
            if (fs.statSync(abs).isDirectory())
                return `${file_path} is a directory`;
            fs.unlinkSync(abs);
            return `File dihapus: ${file_path}`;
        }
    },
    {
        name: 'move_file',
        description: 'Move or rename a file/folder on the server.',
        parameters: {
            from: { type: 'string', description: 'Source path. RELATIVE to the bot root OR ABSOLUTE starting with "/" for any file/folder on the server.', required: true },
            to: { type: 'string', description: 'Destination path. RELATIVE to the bot root OR ABSOLUTE starting with "/".', required: true }
        },
        execute: async ({ from, to }) => {
            const src = path.resolve(ROOT, from);
            const dst = path.resolve(ROOT, to);
            if (!fs.existsSync(src))
                return `Not found: ${from}`;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(src, dst);
            return `${from} -> ${to}`;
        }
    },
    {
        name: 'search_files',
        description: 'Search for files by name on the server. Can search the whole system through an absolute folder parameter, not limited to the project folder.',
        parameters: {
            query: { type: 'string', description: 'The file name or part of it', required: true },
            folder: { type: 'string', description: 'Search folder. RELATIVE to the bot root (default: ".") OR ABSOLUTE starting with "/" to search any directory on the server.', required: false }
        },
        execute: async ({ query, folder = '.' }) => {
            const target = path.resolve(ROOT, folder);
            const results = [];
            const fmt = (b) => b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`;
            function walk(dir, depth = 0) {
                if (depth > 6)
                    return;
                try {
                    for (const item of fs.readdirSync(dir)) {
                        if (['node_modules', '.git'].includes(item))
                            continue;
                        const full = path.join(dir, item);
                        const rel = full.startsWith(ROOT) ? path.relative(ROOT, full) : full;
                        if (item.toLowerCase().includes(query.toLowerCase())) {
                            const s = fs.statSync(full);
                            results.push(`${rel}${s.isFile() ? ` (${fmt(s.size)})` : ''}`);
                        }
                        try {
                            if (fs.statSync(full).isDirectory())
                                walk(full, depth + 1);
                        }
                        catch { }
                    }
                }
                catch { }
            }
            walk(target);
            if (!results.length)
                return `No file matches "${query}"`;
            return `"${query}" — ${results.length} results:\n\n${results.slice(0, 40).join('\n')}`;
        }
    },
    {
        name: 'send_as_file',
        description: 'Send content as a FILE ATTACHMENT (document) on WhatsApp, not as a text message/card. USE THIS TOOL (not send_codeblock) when the file/code to display is LARGE ENOUGH that send_codeblock would need to be called many times (more than ~1-2 parts) — sending many send_codeblock cards in a row makes the chat lag and is heavy on the user\'s phone. A document attachment is much lighter for large files: the user just opens/saves the file, no need to scroll through many messages. For SMALL files that fit in one send_codeblock, still use send_codeblock (it has syntax highlighting, easier to read directly in the chat).\n\nIMPORTANT about the "content" parameter: if file_path points to a file THAT ALREADY EXISTS on the server (reproducing an existing file, not creating a new one), LEAVE the content parameter EMPTY — this tool will read that file DIRECTLY FROM DISK itself, guaranteed exact with no risk of being cut off or mistyped. Fill the content parameter manually ONLY if it is content you composed/assembled yourself from scratch (not a reproduction of an existing file).',
        parameters: {
            file_path: { type: 'string', description: 'File path. If this file ALREADY EXISTS on the server and content is left empty, this path is also used to read its content directly from disk (may be relative to the root OR absolute starting with "/"). If it is only a display name for new content you composed yourself, it can be any name.', required: true },
            content: { type: 'string', description: 'The complete content of the file to send as an attachment. OPTIONAL — leave empty if file_path points to a file that already exists on the server (so it is read directly from disk, which is safer). Fill manually ONLY for content you composed/generated yourself from scratch.', required: false },
            caption: { type: 'string', description: 'Short text that accompanies the file (optional) — e.g. "Here is mcp.js, ~146k characters"', required: false }
        },
        execute: async ({ file_path, content, caption }) => {
            if (ctx().autoHealActive) {
                return 'This tool is disabled during auto-heal — the change diff is already shown to the owner automatically through write_file, do not send the file again here.';
            }
            if (!ctx().conn || !ctx().currentJid)
                return 'WA connection not ready';
            if (!file_path)
                return 'file_path is required';
            let finalContent = content;
            if (!finalContent) {
                if (!ctx().isOwner)
                    return 'Empty content (read-from-disk mode) is only allowed for the owner. Fill the content parameter manually with the content you want to send.';
                const abs = path.resolve(ROOT, file_path);
                if (!fs.existsSync(abs))
                    return `Content is empty and the file was not found on disk: ${file_path}. Fill the content parameter manually, or make sure file_path is correct (an absolute path is allowed).`;
                if (fs.statSync(abs).isDirectory())
                    return `${file_path} is a folder, not a file. Give the path to the file.`;
                finalContent = fs.readFileSync(abs, 'utf-8');
            }
            if (!finalContent)
                return 'Content cannot be empty';
            const ext = (file_path.split('.').pop() || '').toLowerCase();
            const mimeByExt = {
                js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
                json: 'application/json', html: 'text/html', css: 'text/css',
                py: 'text/x-python', md: 'text/markdown', txt: 'text/plain',
                env: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml',
                sh: 'text/x-sh', sql: 'text/plain', xml: 'text/xml'
            };
            const mimetype = mimeByExt[ext] || 'text/plain';
            const fileName = file_path.includes('/') ? file_path.split('/').pop() : file_path;
            try {
                await ctx().conn.sendMessage(ctx().currentJid, {
                    document: Buffer.from(finalContent, 'utf-8'),
                    mimetype,
                    fileName,
                    caption: caption || undefined
                }, { quoted: ctx().currentM });
                return `File "${fileName}" (${finalContent.length} chars) sent as attachment.`;
            }
            catch (e) {
                console.error('[send_as_file] Error:', e);
                return `Failed to send file: ${e.message}. Try send_codeblock instead.`;
            }
        }
    },
    {
        name: 'send_codeblock',
        description: 'Send the content of a file THAT ALREADY EXISTS on the server as a code block with syntax highlighting in the WhatsApp chat. YOU MUST USE THIS TOOL every time the user asks to see the content of a file that ALREADY EXISTS (e.g. "show the content of package.json", "let me see the ai.js code") and it is small (~under 4000 characters) — JUST give file_path, do NOT retype the content yourself into any parameter. This tool reads the file DIRECTLY FROM DISK, guaranteed exact character-for-character, it cannot be cut off or mistyped like when you reproduce it manually. If the file turns out to be too large, this tool tells you to use send_as_file(file_path) instead (also without retyping the content). For code YOU WRITE YOURSELF from scratch (not a reproduction of an existing file), still use the manual JSON format {"__type":"codeblock",...} in the final answer as usual — this tool is ONLY for files that already exist on disk.',
        parameters: {
            file_path: { type: 'string', description: 'Path of the file whose content should be displayed. May be relative to the bot root OR absolute starting with "/". The content is read directly from disk by this tool — do not copy it manually into any other parameter.', required: true },
            title: { type: 'string', description: 'Title shown above the code (optional, defaults to the file name)', required: false },
            description: { type: 'string', description: 'Optional short explanation above the code', required: false }
        },
        execute: async ({ file_path, title, description }) => {
            if (ctx().autoHealActive) {
                return 'This tool is disabled during auto-heal — the change diff is already shown to the owner automatically through write_file, do not send the codeblock again here.';
            }
            if (!ctx().conn || !ctx().currentJid)
                return 'WA connection not ready';
            if (!file_path)
                return 'file_path is required';
            const abs = path.resolve(ROOT, file_path);
            if (!fs.existsSync(abs))
                return `File not found: ${file_path}`;
            if (fs.statSync(abs).isDirectory())
                return `${file_path} is a folder, not a file.`;
            const content = fs.readFileSync(abs, 'utf-8');
            if (content.length > 4000) {
                return `File "${file_path}" is too large for a codeblock (${content.length} chars, limit ~4000 so it is not heavy in the chat). Use the send_as_file tool with the same file_path (leave content empty) instead — no need to re-read it manually.`;
            }
            const ext = (file_path.split('.').pop() || '').toLowerCase();
            const langByExt = {
                js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json',
                html: 'html', css: 'css', py: 'python', md: 'markdown', sh: 'bash',
                sql: 'sql', yml: 'yaml', yaml: 'yaml', env: 'text', txt: 'text', xml: 'xml'
            };
            const language = langByExt[ext] || 'text';
            const fileName = file_path.includes('/') ? file_path.split('/').pop() : file_path;
            try {
                const rich = ctx().conn.aiRich();
                rich.setTitle(title || fileName);
                if (description)
                    rich.addText(description + '\n', { hyperlink: true });
                rich.addCode(language, content);
                await rich.send(ctx().currentJid, { quoted: ctx().currentM });
                return `Codeblock "${fileName}" (${content.length} chars) sent.`;
            }
            catch (e) {
                try {
                    const msg = (title ? `*${title}*\n\n` : '') + (description ? `${description}\n\n` : '') + '```' + language + '\n' + content + '\n```';
                    await ctx().conn.sendMessage(ctx().currentJid, { text: msg }, { quoted: ctx().currentM });
                    return `Codeblock "${fileName}" sent (plain text fallback).`;
                }
                catch (e2) {
                    console.error('[send_codeblock] Error:', e2);
                    return `Failed to send codeblock: ${e2.message}`;
                }
            }
        }
    }
];
