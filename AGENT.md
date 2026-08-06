# AGENT.md — AI Agent Guide for the HIRO-BOT Repo

This document is a mandatory guide for AI coding agents (Claude Code, Cursor, Copilot,
etc.) working in this repo. Read it before making any changes.

HIRO-BOT is a WhatsApp bot built on [Baileys](https://github.com/whiskeysockets/baileys)
with an internal AI Agent (Gemini) that has its own tool-calling. So there are **two
layers of "AI"** that must not be confused:

1. **You (the coding agent)** — editing this repo's source code.
2. **The bot's built-in AI Agent** (defined in `lib/ai/mcp.js`) — the persona/assistant
   that runs at bot runtime and replies to WhatsApp chats. Its system prompt is long and
   already heavily tuned (anti prompt-injection, tone of voice, etc.) — **do not change
   it** unless the user explicitly asks you to change this AI Agent's behavior.

---

## 1. Mandatory Rules for the AI Coding Agent

### 1.1. Hard Prohibitions
- **NEVER read, write, or modify the `.env` file.** It holds real tokens/secrets
  (GIT_TOKEN, AI_KEYS, DISCORD_WEBHOOK, etc.) and must **never** be touched, printed to
  chat/logs, committed, or pushed in any way.
  - If a new config value is needed, **always edit `.env.example`** instead (with an
    empty/placeholder value), then tell the user to fill in their own `.env` manually.
  - `.env` is already auto-added to `.gitignore` by `plugins/owner/github.js` — never
    remove that rule.
- **NEVER** commit/push the `data/` folder (WhatsApp sessions, local database, tmp,
  tunnel cache), `.cache/`, `node_modules/`, lockfiles (`package-lock.json`, etc.), or
  `*.log/*.zip/*.bin` files. All of these are already in `github.js`'s built-in ignore
  rules.
- **NEVER** modify `SYSTEM_PROMPT_BASE` / `DEFAULT_PERSONALITY` in `lib/ai/mcp.js` unless
  explicitly asked by the user — especially the **"ANTI PROMPT-INJECTION"** section; it's
  a bot safety rail, not boilerplate that can be simplified.
- **NEVER** remove or loosen AI tool access gating (`rowner`, `owner`, risk levels
  `blocked/high/medium/low`) in `lib/ai/tools/*.js` or `lib/ai/mcp.js` without explicit
  instruction — many tools (`shell_exec`, `run_eval`, `run_python`, etc.) are
  intentionally locked down to the real owner only.
- **NEVER** create new files in the project root for things that already have a proper
  place (new plugin → `plugins/<category>/`, new AI tool → `lib/ai/tools/`, new scraper →
  `lib/scraper/`).

### 1.2. Code Conventions
- The project uses **pure ESM** (`"type": "module"` in `package.json`), Node.js **v22+**.
  Always `import`/`export`, never `require`.
- Follow the style of the file being edited (indentation, semicolons or not — this repo
  is mixed, so match the file you're touching, don't mass-reformat other files).
- Many lib files (`config.js`, etc.) use **hot-reload via `fs.watchFile`**, and the
  plugin folder is auto-watched by `lib/plugins.js` — don't be surprised if changes
  reload live while the bot is running; that's a feature, not a bug.
- Plugins (`plugins/**/*.js`) MUST follow one of the 4 formats below (see §3.3). Don't
  invent a new format.
- When adding a new AI tool in `lib/ai/tools/`, follow the existing pattern: default
  export an array of `{ name, description, parameters, execute }`, import helpers from
  `../mcp.js` (not the other way around — see §4), and **always write a clear
  `description`**, since that's the only guide the bot's AI Agent has for deciding when
  to call that tool.
- Don't hardcode secrets/tokens in code — always go through `process.env.*` and register
  them in `.env.example`.

### 1.3. Testing / Verification
- This repo has **no automated test suite**. Verify changes by:
  - `node -c <file>` or carefully re-reading the logic (a syntax error in a plugin is
    auto-detected by `syntax-error` on hot-reload and just gets skipped, it doesn't crash
    the bot).
  - For large changes in `lib/`, explain to the user what changed and the risk, because
    `lib/` auto-reloads while the bot is running in production (see the note in
    `UPDATE_LOG`: "Auto reload lib files").

---

## 2. Git Push Rule (MUST be followed in exact order)

If the user asks to **push to GitHub / commit changes / "gitpush"**, the agent **must
not** run `git push` directly. Follow this flow:

1. **Check for the `.git` folder.**
   - If `.git` **doesn't exist**, the repo has never been locally init'd by the agent —
     run `git status` first to confirm, and if there's really no history yet, tell the
     user this will be the first init (`plugins/owner/github.js`'s behavior also runs
     `git init` automatically if it's missing).
   - If `.git` **exists**, proceed to step 2.
2. **Find out which files changed**, using a combination of:
   ```
   git status --porcelain
   git diff --stat
   ```
3. **Find out WHAT changed** in each file (not just the filename), using:
   ```
   git diff -- <file>
   ```
   for already-tracked files, and by reading the file content for new files (status
   `??`). Summarize the change per file briefly and in human-readable form (e.g. "Fix bug
   X in `plugins/dl/spotify.js`", "Add tool Y in `lib/ai/tools/media.js`") — **don't just
   paste the raw diff**.
4. **Update `CHANGELOG.md`** at the project root BEFORE committing/pushing:
   - If `CHANGELOG.md` doesn't exist yet, create it. Follow the format already used by
     the project's `UPDATE_LOG` file (newest entry on top, separated by
     `____________________`, with a date, a short list of changes, then a "Modified
     files:" list). Example entry:
     ```
     06/Aug/2026
     - Fix Spotify download bug on expired token
     - Add ai_edit_image tool in media.js

     Modified files:
     - plugins/dl/spotify.js
     - lib/ai/tools/media.js

     ____________________
     ```
   - Add the new entry at the **very top** of the file (newest on top), don't delete
     older entries.
   - Take the date from the current runtime clock (don't guess).
5. **Only after `CHANGELOG.md` has been updated**, commit & push. Follow the behavior
   already implemented in `plugins/owner/github.js` as a reference:
   - Make sure `.gitignore` contains at least: `.cache/`, `node_modules/`, `.env`,
     `data/`, `*.log`, `*.zip`, `*.bin`, `*.pid`, `*.bak`, lockfiles.
   - `git add .`
   - A short, descriptive commit message based on the step-3 summary (not a generic
     message like "update").
   - Push to branch `main`.
6. **Never** include `.env` contents in any commit, even if accidentally `git add`-ed.
   Always double-check `git status`/`git diff --cached` before committing to make sure
   `.env` was not staged.

The bot command that already implements part of this flow (without the CHANGELOG step)
lives in `plugins/owner/github.js` (`.gitpush` and `.gitstats`) — called by the bot's own
AI Agent via the `run_plugin` tool. If you (the coding agent) are asked to push this repo
from the development side (not from WhatsApp chat), do it manually via the git CLI
following the order above.

---

## 3. How the Project Works

### 3.1. Entry point & lifecycle
```
lib/start.js   → supervisor process: installs dependencies if missing, loads
                 .env, fork()s a child process (lib/main.js) via cluster,
                 auto-restarts on crash (with backoff), watches main.js for
                 restart on change.
lib/main.js    → main process: initializes the WhatsApp connection
                 (Connection), loads plugins, sets up the tunnel
                 (Cloudflare) + website server, cleanup intervals for
                 tmp/store, memory watchdog, global state (see §4).
lib/connection.js → Baileys wrapper: pairing/QR, multi-session, reconnect
                 logic, connection watchdog.
lib/handler.js → central event handler: receives incoming messages (via
                 simple.js → smsg()), checks permissions
                 (owner/mods/premium/group/etc.), resolves command &
                 prefix, runs the matching plugin, forwards errors to
                 autoHeal (AI).
lib/simple.js  → extensions/monkey-patches on the Baileys `conn` object
                 (protoType): all the conn.reply/conn.sendFile/conn.aiRich()/etc
                 methods (see full examples in README.md).
lib/plugins.js → plugin loader: recursively reads all files under /plugins,
                 watches the folder for hot-reload, syntax-checks before
                 reload.
lib/database.js→ database abstraction: defaults to local JSON (lowdb-style
                 in data/*.json), or a MongoDB/MySQL/SQLite/Cloud adapter
                 depending on the DATABASE env var.
lib/server.js  → HTTP server (website: index.html, profile.html) + exposes
                 a public endpoint via Cloudflare Tunnel / custom hostname.
lib/ai/mcp.js  → the bot's AI Agent "brain": system prompt, agent loop
                 (runAgent), tool registry (loadToolsDir from
                 lib/ai/tools/*.js), Gemini API key rate-limit/rotation,
                 auto-heal errors via Gemma.
```

### 3.2. Incoming message flow (simplified)
```
WhatsApp → Baileys (connection.js) → messages.upsert
  → simple.js: smsg(conn, msg) → normalize into an `m` object
  → handler.js: checks self/pconly/gconly/queue/restrict, resolves the
    plugin from prefix + command
  → runs plugin.run/handler(m, { conn, args, command, ... })
  → if handler.ai exists & the message triggers AI (mention/reply/.ai
    prefix/etc.)
    → lib/ai/mcp.js: runAgent() → calls Gemini with the registered tools
      → a tool can call back into another plugin via run_plugin
        (execPluginCommand)
  → error in any plugin → autoHeal (handleError in mcp.js) → optional
    auto-fix using the Gemma model if settings.ai.autoheal = true
```

### 3.3. Plugin format (4 supported variants)
```javascript
// A. Handler style
let handler = async (m, { conn }) => { /* ... */ };
handler.command = /^ping$/i;      // Array / String / RegExp
handler.help = ['ping'];
handler.tags = ['main'];
handler.rowner/owner/mods/group/private/botAdmin/premium/admin = Boolean;
handler.limit = Boolean | Number;
handler.level = Number;
handler.customPrefix = String;
handler.ai = { risk: 'low'|'medium'|'high'|'blocked', summarize: Boolean, description: String };
export default handler;

// B. Handler with a before-hook (runs before command matching, e.g. for 2-step state)
let handler = (m) => m;
handler.before = async (m, { conn }) => { /* ... */ };
export default handler;

// C. Export-object style (equivalent to A, but run: instead of a default function)
export default { run: async (m, { conn }) => {}, command, tags, help, ...flags };

// D. Export-object with only a before hook
export default { async before(m, { conn }) { /* ... */ } };
```
`handler.ai` determines whether this plugin can be run by the AI Agent via `run_plugin`
(without `handler.ai`, a plugin is treated as internal-only and never exposed to the AI).

### 3.4. Folder structure
```
HIROBOT
├── lib
│   ├── ai/
│   │   ├── mcp.js          # AI agent brain + tool loader
│   │   └── tools/*.js      # all AI tools (see §4.2)
│   ├── scraper/*.js        # per-platform scrapers (tiktok, ig, x, ytdl, etc.)
│   ├── config.js           # global.settings (owner/mods/tier/default messages)
│   ├── connection.js       # Baileys connection
│   ├── converter.js        # media conversion (via ffmpeg etc.)
│   ├── database.js         # database manager (json/mongo/mysql/sqlite)
│   ├── handler.js          # event handler
│   ├── helper.js           # general utils (source of many globals, see §4.1)
│   ├── main.js             # tunnel, all intervals, global bootstrap
│   ├── plugins.js          # plugin loader + hot reload
│   ├── server.js           # website endpoint
│   ├── simple.js           # extension methods on the conn object
│   ├── sticker.js          # sticker builder
│   ├── start.js            # supervisor/entrypoint (`node .`)
│   └── views/*.html        # website pages
├── data/                   # sessions, database json, tmp, tunnel data (DO NOT commit)
├── plugins/                # all bot commands, per category folder
│   ├── ai/ group/ sticker/ dl/ owner/ tools/ main/ subbot/ _event/
├── .env                    # real tokens — DO NOT TOUCH
├── .env.example            # env template — edit this if a new var is needed
├── package.json
├── README.md
└── UPDATE_LOG              # manual changelog (see also CHANGELOG.md §2)
```

---

## 4. Available Functions & Globals

### 4.1. Global variables
Most globals are set via `Object.assign(global, { ...Helper, timestamp:
{ start: Date.now() } })` in `lib/main.js` (so every export from `lib/helper.js`
automatically becomes global too), plus a few set manually elsewhere:

| Global | Source | Contents |
|---|---|---|
| `global.settings` | `lib/config.js` | owner/mods list, ai (thinking/autoheal), subbot config, tier, default messages (`msg.rowner`, etc.) |
| `global.readmore` | `lib/config.js` | invisible character used for WA "read more" |
| `global.db` | `lib/handler.js` | the active database instance (`db.data.users/chats/stats/msgs/settings`) |
| `global.opts` | `lib/helper.js` (via Object.assign) | parsed CLI args (`--self`, `--pconly`, `--gconly`, `--swonly`, `--queue`, `--noprint`, `--autoread`, `--restrict`, `--nyimak`, etc.) |
| `global.prefix` | `lib/helper.js` (via Object.assign) | the active command prefix RegExp |
| `global.__filename/__dirname/__require/checkFileExists/saveStreamToFile/isReadableStream/importFile` | `lib/helper.js` | filesystem/module utils (see §4.5) |
| `global.timestamp` | `lib/main.js` | `{ start, connect }` — process start time & WA connect time |
| `global.support` | `lib/main.js` | `{ ffmpeg, ffprobe, ffmpegWebp, find }` — path/status of media-tool binaries |
| `global.tunnel` | `lib/main.js` | Cloudflare tunnel state `{ proc, url, pid, reused, static, named }` |
| `global.websiteState` | `lib/main.js` | `{ mode, url }` for the website's public mode |
| `global.getServerUrl()` | `lib/main.js` | function to get the current public URL |
| `global.startTunnel` / `global.restartTunnel` | `lib/main.js` | manual tunnel control |
| `global.activeIntervals` | `lib/main.js` | a `Set` of all active `setInterval`s (for cleanup) |
| `global.server` | `lib/server.js` | the HTTP server instance |
| `global.ephemeral` | used in `simple.js` | default ephemeral message duration |
| `global.img` | `plugins/_event/system.js` | image-related cache/state |
| `global.igDownloadState` / `global.pinterestDlState` | related plugins | multi-step download session state |
| `global.dfail` | `lib/handler.js` | `async (type, m, conn)` — standard failure-message helper |
| `global.gc` | Node.js (`--expose-gc`) | manual garbage-collection trigger (used in the memory watchdog) |

### 4.2. AI Tools (`lib/ai/tools/*.js`)
All of these tools are called by the bot's AI Agent (Gemini) via function-calling in
`lib/ai/mcp.js`. Each tool is a `{ name, description, parameters, execute }` object,
auto-loaded by `loadToolsDir` — just add a new file to this folder to register a new
tool.

| File | Tools |
|---|---|
| `database.js` | `read_database`, `write_database` |
| `files.js` | `read_file`, `write_file`, `list_files`, `delete_file`, `move_file`, `search_files`, `send_as_file`, `send_codeblock` |
| `group.js` | `get_group_info`, `group_member_action`, `group_settings`, `group_link`, `group_leave`, `group_join_requests` |
| `media.js` | `download_media`, `generate_image`, `ai_edit_image` |
| `memory.js` | `remember`, `recall`, `list_learned`, `forget`, `pin_note`, `unpin_note`, `list_pinned_notes`, `log_failure` |
| `messaging.js` | `send_message`, `list_owners`, `forward_media`, `reply_now`, `send_rich_reply` |
| `plugin.js` | `run_eval`, `list_plugins`, `run_plugin`, `check_plugin_risk`, `read_plugin_guide` |
| `reminder.js` | `create_reminder`, `list_reminders`, `cancel_reminder` |
| `system.js` | `system_time`, `shell_exec`, `run_python`, `system_info`, `restart_bot`, `install_package` |
| `web.js` | `view_website`, `fetch_html_raw`, `view_link_post`, `search_web` |

### 4.3. Key helpers/functions from `lib/ai/mcp.js` (used by the tool files)
```
-- Session / chat history --
getSession(jid) / resetSession(jid) / getPinnedNotesReadOnly(jid)

-- Talking to the AI / agent loop --
runAgent(conn, m, text, opts) / runAgentConfirmed(conn, m, opts)
callTool(name, args) / listTools() / countTools()

-- Identity & permissions --
getUserIdentity(jid, db, conn) / checkGroupAdminOrOwner(groupJid)
readGroupSettings(groupJid) / readOwnerList()

-- Persistent storage ("brain") --
loadBrain() / saveBrain(brain) / ensureBrainGroupSlot(brain, jid)

-- Web & media --
searchWebGrounded(query) / captureWebsiteScreenshot(url) / fetchWebsiteHtmlFallback(url)
peekFetchBuffer(url, headers) / peekfetchVideoBuffer(url, maxBytes, headers)
detectPlatform(url) / peekAnalyzeWithVision(mediaItems, platform, url, context)
buildMediaPart(m) / fetchSocialMulti(url) / downloadUserImageAsUrl(m)

-- File & data tools --
readFileToolCore(file_path, offset) / buildSimpleDiff(oldStr, newStr) / parseDbKeyPath(key_path)

-- Plugin execution (advanced/internal) --
resolvePlugin(command) / resolveCustomPrefixPlugin(rawInput)
execPluginCommand(command, argsStr, opts) / execEval(code, opts)
classifyPluginRisk(name, plugin) / accessLabel(level) / riskBadge(level)
pluginRequirements(plugin) / getDangerousDocReason(m)

-- Error handling & internals --
handleError(conn, m, err, pluginName) / isTransientApiError(err)
getApiKeys() / getNextKey() / rotateKey() / resetRateLimit(jid)
normalizeApiKeys(input) / getPersonality() / MODELS
setCurrentContext(...) / hasPending() / confirmPending() / cancelPending()

-- Context helper (used inside tool files) --
ctx() -> { currentJid, conn, isOwner, isROwner, timezone, ... } (always fresh)
```
Important note: `mcp.js` **never** statically imports files from `./tools` (they're
loaded dynamically via `loadToolsDir`), so a tool file can safely `import { ctx, ... }
from '../mcp.js'` at the top level with no circular-import issue.

### 4.4. Key `conn` functions (from `lib/simple.js`, patched onto the Baileys object)
```javascript
conn.reply(m.chat, text, m)
conn.sendFile(m.chat, media, filename, caption, m)   // media: buffer/fs path
conn.sendContact(m.chat, [[number, name], ...], m)
conn.react(m.chat, emoji, m.key)
conn.sendLocUrl(m.chat, thumbUrl, title, address, text, footer, url, m)
conn.sendUrlPreview(m.chat, thumbUrl, text, title, desc, highQuality, m)
conn.sendButton(m.chat, { text/image/caption, footer, cards/nativeFlow/optionText, ... }, m)
conn.aiRich().setTitle().addText().addImage().addCode().addTable().addSource().addTip()
  .addSuggest().send(m.chat, { quoted: m })
conn.sendStickerPack(m.chat, { cover, stickers, name, publisher, description })
```
Full details for each function + examples are in `README.md` (the "Send Message"
section).

### 4.5. General helpers (`lib/helper.js`, default export `Helper`)
```
Helper.__filename(pathURL, rmPrefix?) / Helper.__dirname(pathURL)
Helper.__require(dir?) / Helper.checkFileExists(file)
Helper.saveStreamToFile(stream, file) / Helper.isReadableStream(stream)
Helper.importFile(module)   // dynamic import with cache-busting by file hash
Helper.opts / Helper.prefix // same as global.opts / global.prefix
```

### 4.6. `MODELS` mapping (`lib/ai/mcp.js`)
```javascript
export const MODELS = {
    default: 'gemini-3.1-flash-lite',   // .ai
    flash: 'gemini-3.5-flash',          // .ai:flash
    'flash-lite': 'gemini-3.1-flash-lite',
    pro: 'gemini-2.5-pro',              // .ai:pro
    gemma: 'gemma-4-31b-it',            // .ai:gemma — no tools, reasoning/coding only
    'gemma-moe': 'gemma-4-26b-a4b-it',  // .ai:gemma-moe — no tools, reasoning/coding only
};
```
The Gemma model is also used internally for **auto-heal** (see §5.7), not just called
manually via command.

---

## 5. Technical Detail of Other Modules in `lib/`

### 5.1. `lib/connection.js`
A wrapper around Baileys (`makeWASocket`) for the main bot connection. Things to know:
- Supports **pairing code** (including a custom pairing code via the `CUSTOM_PAIRING`
  env var, must be 8 characters) as well as **QR code** — automatic fallback if one
  fails.
- There's a **connection watchdog** (`global._optikWatchdog`, `setInterval`) that
  monitors socket status and auto-reconnects on drop, with special handling for
  `DisconnectReason` (loggedOut vs restartRequired vs a regular error).
- `global.timestamp.connect` is set once the socket successfully connects.
- Reused by `plugins/subbot/connect.js` for multi-session (subbot) support, see §5.6.

### 5.2. `lib/database.js` — Multi-adapter Database
Default: **local JSON** (`data/*.json`, loaded via `database.read()/write()`, wrapped
with `lodash` via `database.chain`). Can be swapped via the `DATABASE` env var to one of:
- `MongoDBV2` / `mongoDB` — MongoDB (requires the `mongoose` package, lazily
  auto-installed if missing from `node_modules`).
- `MySqlAdapter` — MySQL, URL format: `jdbc:mysql://user:pass@host:port/database`.
- `SQLiteAdapter` — uses Node.js's built-in `node:sqlite`.
- `CloudDBAdapter` — a custom cloud adapter.

All adapters are accessed through the same interface (`database.data`,
`database.read()`, `database.write()`), so other code (plugins/AI tools) **doesn't need
to know** which adapter is active — always access it via `global.db` /
`db.data.{users,chats,stats,msgs,settings}`.

**`db.data` structure (main schema):**
```
db.data.users  = { [jid]: { name, exp, limit, premium, premiumTime, level, registered, ... } }
db.data.chats  = { [jid]: { welcome, isBanned, aiEnabled?, ... } }
db.data.stats  = { [key]: number }   // command usage stats
db.data.msgs   = { [key]: object }   // saved messages (dbmsg tools: get/add/del/list vn/msg/img/etc.)
db.data.settings = { ... }           // additional global settings
```
The website (`lib/server.js`) also reads/writes `db.data.users` for the
**register/login/OTP, tier, EXP, gems, gift code, premium** system — see §5.3.

### 5.3. `lib/server.js` — Website & REST API
Besides serving static files from `lib/views/*.html`, `server.js` also exposes a **REST
API** (under `/api/*`) that powers the bot's web dashboard (user login/register,
profile, tier system, gift codes, etc.). Routes are built via the `get(path, handler)` /
`post(path, handler)` helpers inside `buildRoutes(conn)`. Current endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | health check |
| GET | `/api/tierAsset` | tier asset/label |
| GET | `/api/botInfo` | general bot info (name, icon, etc.) |
| GET | `/api/commandList` | command list (same source as `.menu`) |
| GET | `/api/envExample` | contents of `.env.example` (NOT the real `.env`!) |
| POST | `/api/register` | website account registration |
| POST | `/api/login` | login |
| POST | `/api/verify-otp` / `/api/resend-otp` | OTP verification |
| GET | `/api/profile` | user profile data (exp, tier, limit, etc.) |
| POST | `/api/daily` | claim daily reward |
| POST | `/api/tierup` | tier upgrade |
| POST | `/api/change-password` / `/api/rename` | account updates |
| POST | `/api/redeem` | redeem a gift code |
| POST | `/api/buy-limit` / `/api/buy-premium` | buy limit/premium with gems |
| POST | `/api/slot` | slot/gacha feature (gems) |
| GET | `/api/gems` | gems balance |
| POST | `/api/logout` | logout |
| GET | `/api/check-owner` | check whether the request is from the owner |
| GET/POST | `/api/admin/giftcodes*` | gift code CRUD (admin only) |
| GET | `/api/premium-notice` | premium status notification |
| GET | `/api/user-search` / `/api/admin/users` | search/list users (admin) |
| POST | `/api/admin/update-user` / `/api/admin/delete-user` | manage users (admin) |
| POST | `/api/check-number` | check whether a WA number is registered |

- Non-`/api/` `GET` routes are served as **static files** from `lib/views/`
  (`index.html`, `profile.html`).
- There's a **WebSocket server** (`WebSocketServer`) that pipes all events from `conn`
  (the Baileys connection) to browser clients in real time (prefix `conn-`), used for
  live status on the website (e.g. showing the QR/pairing code without a refresh).
- There's a simple in-memory rate limit (`checkMemoryRateLimit`) specifically for all
  `/api/*` paths.
- **Don't** expose sensitive data (password hashes, tokens) through any endpoint —
  follow the existing pattern (passwords are always hashed, OTPs have an expiry).

### 5.4. `lib/sticker.js`
Exports: `sticker(...)` (builds a `.webp` file from an image/video buffer, used by the
`sticker.js`, `brat.js`, etc. plugins) and `addExif(...)` (writes pack-name/author
metadata to a webp sticker, used by `setwm.js`, etc.).

### 5.5. `lib/converter.js`
Exports: `toAudio`, `toPTT`, `toVideo`, `ffmpeg` (and related utils) — all
`fluent-ffmpeg`-based media conversion, used by the `tools/convert.js` plugin and
various downloaders.

### 5.6. Subbot System (`plugins/subbot/*`)
This bot supports **multi-session** — users can link their own WA number as a "subbot"
attached to the main bot instance:
- `.pairing` / `.connect` / `.reconnect` / `.disconnect` (`plugins/subbot/connect.js`) —
  creates a new session using a separate `makeWASocket`, stored under
  `data/sessions/subbot/<id>` (`settings.subbot.path`), capped by
  `settings.subbot.maxConnect` (default 3) concurrent active sessions, and
  `settings.subbot.autoConnect` for auto-reconnecting previously-connected subbots when
  the main bot restarts.
- `.listsubbot` (`plugins/subbot/list.js`) — view active subbots.

### 5.7. Advanced AI System (in `lib/ai/mcp.js`)
- **Model routing**: commands `.ai`, `.ai:flash`, `.ai:pro`, `.ai:gemma`,
  `.ai:gemma-moe` (regex `/^ai(:[a-z-]+)?$/i` in `plugins/ai/ai.js`) — the suffix after
  `:` is mapped to `MODELS` (§4.6). The **Gemma** models (`gemma-4-31b-it`,
  `gemma-4-26b-a4b-it`) have **no** tool-calling/search access at all (pure
  reasoning/coding text), unlike Gemini (`default`, `flash`, `pro`), which has full
  tool-calling.
- **Thinking mode**: controlled by `global.settings.ai.thinking` (in `lib/config.js`).
  When `true`, requests to Gemini include `thinkingConfig: { thinkingBudget: -1 }`
  (dynamic thinking), and a progress step ("Thinking...") is sent live to chat via
  `opts.onStep`. Doesn't apply to the Gemma model (no thinkingConfig support).
- **Auto-heal**: controlled by `global.settings.ai.autoheal` (default `false`), and can
  be force-disabled via the `DISABLE_AUTO_HEAL=true` env var. Flow (`handleError` in
  `mcp.js`, called from `lib/handler.js` whenever a plugin errors):
  1. If the error is **intentional** (a plugin deliberately did `throw new
     Error("validation message")`) or a **transient/downstream API error** (rate limit,
     a third-party API being down) → auto-heal is **skipped**, only a plain message is
     sent to the user (not treated as a bug).
  2. If it's a real bug and auto-heal is on → the bot sends an "Auto-fix in
     progress..." status to the chat, then the **Gemma** model is called to try to
     analyze & fix the source file that errored (`findSourceFiles(err)`), with a
     **5-minute cooldown** per error-key to avoid spamming retries on the same
     recurring error.
  3. If auto-heal is off/disabled → the error is only reported to the owner (with
     details) or to a regular user (a generic "Something went wrong" message).
- **Rate limit & API key pool**: `AI_KEYS` in `.env` can be a single key (string) or
  many keys (JSON array) for fallback — `getNextKey()/rotateKey()` automatically switch
  keys when one hits a rate limit, `resetRateLimit(jid)` resets the limit per-chat.

---

## 6. Plugin List by Category (command triggers)
The runtime source of truth is still `list_plugins`/`.menu` (it can change as new
plugins are added), but here's a snapshot of the commands present in this repo by
category folder:

| Category (`plugins/<folder>/`) | Commands |
|---|---|
| `main/` | `menu`/`help`/`?`, `ping`/`speed`, `profile`, `daftar`/`register`, `owner`/`creator`, `speedtest`, `enable`/`disable`/`on`/`off` |
| `ai/` | `ai`/`ai:<model>`, `aicheck`, `gpt`, `mistral`, `pollination` |
| `group/` | `add`, `groups`/`grouplist`, `groupinfo`/`infogroup`/`infogc`, `linkgroup`, `group` (open/close), `promote`, `setwelcome`/`setbye`, `simulate` |
| `sticker/` | `sticker`/`s`/`stickergif`/`stickerwm`, `brat`/`bratvid`, `sprem`, `setwm`, `wm`, `smeta`, `telesticker`/`stickertele`/`stele` |
| `dl/` (downloader) | `spotify`, `yt`/`play`/`ytv`/`ytaudio`/`ytsearch`, `tt`/`tiktok`(`audio`), `ig`/`instagram`/`igdl`, `fb`/`facebook`/`fbdl`, `x`/`twitter`, `reddit`/`redditdl`, `pinterest`/`pint`, `mediafire`/`mf`, `gdrive`/`gd`, `e621`, `animein`, `ph`/`pornhub` |
| `owner/` | `backup`, `gitpush`/`gitstats`, `restart`, `setbotpp`, `grep <keyword>`, `save*`/`getplugin`/`gp` (file.js), eval prefix `<`/`<<`/`$ ` (exec.js, **rowner only**) |
| `tools/` | `toimg`/`tovideo`/`tovn`/`toptt`/`tomp3`/`toaudio`, `resize`, `hd`/`upscale`, `imgmotion`, `ssweb`, `tourl`/`upload`, `getexif`, `fetch`/`get`, `delete`, `readviewonce`/`rvo`, `get/add/del/list` + `vn/msg/video/audio/img/sticker/gif` (dbmsg.js) |
| `subbot/` | `pairing`/`connect`/`reconnect`/`disconnect`, `listsubbot`/`listbot` |
| `_event/` | Not a regular command — internal event hooks: `system.js` (welcome/leave, etc.), `getmsg.js`, `buttonResponse.js` (handles native-flow button clicks) |

## 7. Full Environment Variable Reference (`.env.example`)
| Var | Required? | Notes |
|---|---|---|
| `BOT_NAME` | **Required** | Bot's name, used in the AI system prompt & UI |
| `OWNER` / `MODERATOR` | Optional (empty by default) | JSON array `[["628xxx","Name",true], ...]` |
| `CUSTOM_PAIRING` | Optional | Custom pairing code, max 8 characters |
| `GROUP_ID` | Optional | For LID solver, set an invite link or group JID |
| `DISCORD_WEBHOOK` | Optional | Used by `plugins/tools/upload.js` |
| `SPOTIFY_TOKEN` | Optional | Fallback `client_id:client_secret` when anonymous Spotify hits a 429 |
| `AI_PERSONALITY` | Optional | Overrides `DEFAULT_PERSONALITY` in `mcp.js` |
| `AI_KEYS` | **Required for AI features** | 1 key (string) or several (JSON array), from aistudio.google.com |
| `GIT_CLASSIC_KEY` / `GIT_TOKEN` / `GIT_USER` / `GIT_EMAIL` / `GIT_REPO` | Optional (dev/fork only) | Credentials for `.gitpush` |
| `DATABASE` | Optional | Empty = local JSON; set this to use MySQL/MongoDB/SQLite/Cloud adapter |
| `CLOUDFLARE_TUNNEL_TOKEN` / `CLOUDFLARE_TUNNEL_HOSTNAME` | Optional | Custom domain via Cloudflare Tunnel |
| `HOSTNAME_PUBLIC` | Optional | Public hostname if not using a tunnel |
| `DISABLE_AUTO_HEAL` | Optional (not in `.env.example`, but read by the code) | `"true"` to force-disable auto-heal |

**Additional rule**: if a new env var is needed, add it to `.env.example` with an
empty/placeholder value + an explanatory comment (follow the existing style), **never**
put a real/secret value into `.env.example`.

---

## 8. Quick Summary (TL;DR)
- Don't touch `.env`, only `.env.example`.
- Before `gitpush`: check `.git` → check changed files → check what changed → update
  `CHANGELOG.md` → then commit & push.
- Don't change the AI Agent's system prompt (`lib/ai/mcp.js`) or tool risk gating
  without being asked.
- New plugins follow one of the 4 standard formats in §3.3, placed in
  `plugins/<category>/`.
- New AI tools go in `lib/ai/tools/`, following the `{ name, description, parameters,
  execute }` pattern.
- All globals are available without importing (see §4.1) — check first before
  reimplementing something that already exists.
