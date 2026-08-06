# AGENT.md — Panduan AI Agent untuk Repo HIRO-BOT

Dokumen ini adalah panduan wajib untuk AI coding agent (Claude Code, Cursor, Copilot,
dsb) yang bekerja di repo ini. Baca dokumen ini sebelum melakukan perubahan apapun.

HIRO-BOT adalah WhatsApp bot berbasis [Baileys](https://github.com/whiskeysockets/baileys)
dengan AI Agent internal (Gemini) yang punya tool-calling sendiri. Jadi ada **dua lapis
"AI"** yang jangan sampai tertukar:

1. **Kamu (coding agent)** — yang mengedit source code repo ini.
2. **AI Agent bawaan bot** (didefinisikan di `lib/ai/mcp.js`) — persona/asisten yang
   berjalan di runtime bot dan membalas chat WhatsApp user. System prompt-nya panjang
   dan sudah sangat dituning (anti prompt-injection, gaya bahasa, dsb) — **jangan
   diubah** kecuali user secara eksplisit minta ubah perilaku AI Agent bot ini.

---

## 1. Rules Wajib untuk AI Coding Agent

### 1.1. Larangan Keras
- **JANGAN PERNAH membaca, menulis, atau mengubah file `.env`.** File ini berisi token/secret
  asli (GIT_TOKEN, AI_KEYS, DISCORD_WEBHOOK, dsb) dan **tidak boleh** disentuh, dicetak ke
  chat/log, di-commit, atau di-push dengan cara apapun.
  - Kalau perlu menambah konfigurasi baru, **selalu edit `.env.example`** saja (dengan value
    kosong/placeholder), lalu beri tahu user untuk mengisi `.env` miliknya sendiri secara manual.
  - `.env` sudah otomatis masuk `.gitignore` lewat `plugins/owner/github.js`, jangan pernah
    menghapus rule itu.
- **JANGAN** commit/push folder `data/` (sessions WhatsApp, database lokal, tmp, cache tunnel),
  `.cache/`, `node_modules/`, lockfile (`package-lock.json`, dst), atau file `*.log/*.zip/*.bin`.
  Semua itu sudah ada di ignore-rules bawaan `github.js`.
- **JANGAN** mengubah `SYSTEM_PROMPT_BASE` / `DEFAULT_PERSONALITY` di `lib/ai/mcp.js` kecuali
  diminta eksplisit oleh user — terutama bagian **"ANTI PROMPT-INJECTION"**, itu adalah safety
  rail bot, bukan boilerplate yang boleh disederhanakan.
- **JANGAN** menghapus/melonggarkan gating akses tool AI (`rowner`, `owner`, risk level
  `blocked/high/medium/low`) di `lib/ai/tools/*.js` atau `lib/ai/mcp.js` tanpa instruksi
  eksplisit — banyak tool (`shell_exec`, `run_eval`, `run_python`, dsb) sengaja dibatasi ketat
  ke real owner saja.
- **JANGAN** membuat file baru sembarang di root project untuk hal yang sudah punya tempatnya
  (plugin baru → `plugins/<kategori>/`, tool AI baru → `lib/ai/tools/`, scraper baru →
  `lib/scraper/`).

### 1.2. Konvensi Kode
- Project pakai **ESM murni** (`"type": "module"` di `package.json`), Node.js **v22+**.
  Selalu `import`/`export`, jangan `require`.
- Ikuti gaya file yang sedang diedit (indentasi, ada/tidaknya semicolon — repo ini campuran,
  jadi cocokkan dengan file yang sedang disentuh, jangan reformat massal file lain).
- Banyak file lib (`config.js`, dsb) pakai **hot-reload via `fs.watchFile`** dan plugin folder
  di-watch otomatis oleh `lib/plugins.js` — jangan heran kalau perubahan langsung ke-reload
  saat bot jalan, ini fitur, bukan bug.
- Plugin (`plugins/**/*.js`) HARUS mengikuti salah satu dari 4 format di bawah (lihat §3.3).
  Jangan buat format baru sendiri.
- Kalau menambah tool AI baru di `lib/ai/tools/`, ikuti pola yang sudah ada: default export
  array of `{ name, description, parameters, execute }`, import helper dari `../mcp.js` (bukan
  sebaliknya — lihat §4), dan **selalu isi `description` yang jelas** karena itu satu-satunya
  panduan buat AI Agent bot memutuskan kapan tool itu dipanggil.
- Jangan hardcode secret/token di kode — selalu lewat `process.env.*` dan didaftarkan di
  `.env.example`.

### 1.3. Testing / Verifikasi
- Repo ini **tidak punya automated test suite**. Verifikasi perubahan dengan:
  - `node -c <file>` atau baca ulang logikanya dengan teliti (syntax error di plugin akan
    otomatis terdeteksi oleh `syntax-error` saat hot-reload dan hanya di-skip, tidak crash bot).
  - Untuk perubahan besar di `lib/`, jelaskan ke user apa yang berubah dan risikonya, karena
    `lib/` di-reload otomatis saat bot production jalan (lihat catatan di `UPDATE_LOG`: "Auto
    reload lib files").

---

## 2. Rule Git Push (WAJIB diikuti persis urutannya)

Kalau user minta **push ke GitHub / commit perubahan / "gitpush"**, agent **tidak boleh**
langsung `git push`. Ikuti alur berikut:

1. **Cek folder `.git`.**
   - Kalau `.git` **tidak ada**, berarti repo belum pernah di-init secara lokal oleh agent —
     jalankan `git status` dulu untuk pastikan, dan kalau memang belum ada history, beri tahu
     user bahwa ini akan jadi init pertama (perilaku `plugins/owner/github.js` juga melakukan
     `git init` otomatis kalau belum ada).
   - Kalau `.git` **ada**, lanjut ke langkah 2.
2. **Cari tahu file apa saja yang berubah**, pakai kombinasi:
   ```
   git status --porcelain
   git diff --stat
   ```
3. **Cari tahu APA yang berubah** di tiap file (bukan cuma nama filenya), pakai:
   ```
   git diff -- <file>
   ```
   untuk file yang sudah pernah di-track, dan baca isi file untuk file yang statusnya baru (`??`).
   Rangkum perubahan per file secara singkat dan human-readable (mis. "Fix bug X di
   `plugins/dl/spotify.js`", "Tambah tool Y di `lib/ai/tools/media.js`") — **jangan asal
   copy-paste diff mentah**.
4. **Update `CHANGELOG.md`** di root project SEBELUM commit/push:
   - Kalau `CHANGELOG.md` belum ada, buat baru. Ikuti format yang sudah dipakai project di file
     `UPDATE_LOG` (urutan terbaru di atas, dipisah `____________________`, ada tanggal, daftar
     ringkas perubahan, lalu daftar "Modified files:"). Contoh entri:
     ```
     06/Aug/2026
     - Fix bug download Spotify saat token expired
     - Tambah tool ai_edit_image di media.js

     Modified files:
     - plugins/dl/spotify.js
     - lib/ai/tools/media.js

     ____________________
     ```
   - Tambahkan entri baru di **paling atas** file (paling baru di atas), jangan menghapus
     entri lama.
   - Ambil tanggal dari waktu berjalan saat ini (bukan menebak).
5. **Baru setelah `CHANGELOG.md` ter-update**, lakukan commit & push. Ikuti perilaku yang
   sudah ada di `plugins/owner/github.js` sebagai referensi:
   - Pastikan `.gitignore` mengandung minimal: `.cache/`, `node_modules/`, `.env`, `data/`,
     `*.log`, `*.zip`, `*.bin`, `*.pid`, `*.bak`, lockfile.
   - `git add .`
   - Commit message singkat & deskriptif berdasarkan rangkuman langkah 3 (bukan pesan generik
     seperti "update").
   - Push ke branch `main`.
6. **Jangan pernah** menyertakan isi `.env` di commit manapun, walau tidak sengaja ter-`git add`.
   Selalu double-check `git status`/`git diff --cached` sebelum commit untuk pastikan `.env`
   tidak ikut ter-stage.

Command bot yang sudah mengimplementasikan sebagian alur ini (tanpa langkah CHANGELOG) ada di
`plugins/owner/github.js` (`.gitpush` dan `.gitstats`) — dipanggil oleh AI Agent bot sendiri
lewat tool `run_plugin`. Kalau kamu (coding agent) diminta push repo ini dari sisi development
(bukan dari chat WhatsApp), lakukan manual via git CLI dengan mengikuti urutan di atas.

---

## 3. Cara Kerja Project

### 3.1. Entry point & lifecycle
```
lib/start.js   → supervisor process: install dependency kalau belum ada,
                 load .env, fork() child process (lib/main.js) lewat cluster,
                 auto-restart kalau crash (dengan backoff), watch file main.js
                 untuk restart saat berubah.
lib/main.js    → proses utama: init koneksi WhatsApp (Connection), load plugin,
                 setup tunnel (Cloudflare) + website server, interval cleanup
                 tmp/store, memory watchdog, global state (lihat §4).
lib/connection.js → wrapper Baileys: pairing/QR, multi-session, reconnect logic,
                 watchdog koneksi.
lib/handler.js → event handler pusat: terima pesan masuk (via simple.js →
                 smsg()), cek permission (owner/mods/premium/group/dsb),
                 resolve command & prefix, jalankan plugin yang match,
                 serialize error ke autoHeal (AI).
lib/simple.js  → ekstensi/monkey-patch di object `conn` Baileys (protoType):
                 semua method conn.reply/conn.sendFile/conn.aiRich()/dst
                 (lihat contoh lengkap di README.md).
lib/plugins.js → plugin loader: baca semua file di /plugins secara rekursif,
                 watch folder untuk hot-reload, syntax-check sebelum reload.
lib/database.js→ database abstraction: default JSON lokal (lowdb-style di
                 data/*.json), atau adapter MongoDB/MySQL/SQLite/Cloud
                 tergantung env DATABASE.
lib/server.js  → HTTP server (website: index.html, profile.html) + expose
                 endpoint publik lewat Cloudflare Tunnel / hostname custom.
lib/ai/mcp.js  → "otak" AI Agent bot: system prompt, agent loop (runAgent),
                 tool registry (loadToolsDir dari lib/ai/tools/*.js), rate
                 limit/rotasi API key Gemini, auto-heal error via Gemma.
```

### 3.2. Alur pesan masuk (simplified)
```
WhatsApp → Baileys (connection.js) → messages.upsert
  → simple.js: smsg(conn, msg) → normalize jadi object `m`
  → handler.js: cek self/pconly/gconly/queue/restrict, resolve plugin dari
    prefix + command
  → jalankan plugin.run/handler(m, { conn, args, command, ... })
  → kalau ada handler.ai & pesan trigger AI (mention/reply/prefix .ai/dsb)
    → lib/ai/mcp.js: runAgent() → panggil Gemini dengan tools yang terdaftar
      → tool bisa manggil balik plugin lain via run_plugin (execPluginCommand)
  → error di plugin manapun → autoHeal (handleError di mcp.js) → opsional
    auto-fix pakai model Gemma kalau settings.ai.autoheal = true
```

### 3.3. Format plugin (4 varian yang didukung)
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

// B. Handler dengan before-hook (jalan sebelum command matching, mis. utk state 2-step)
let handler = (m) => m;
handler.before = async (m, { conn }) => { /* ... */ };
export default handler;

// C. Export-object style (setara A, tapi run: bukan default function)
export default { run: async (m, { conn }) => {}, command, tags, help, ...flags };

// D. Export-object dengan before saja
export default { async before(m, { conn }) { /* ... */ } };
```
`handler.ai` menentukan apakah plugin ini bisa dijalankan AI Agent lewat `run_plugin`
(tanpa `handler.ai`, plugin dianggap internal-only dan tidak akan pernah muncul ke AI).

### 3.4. Struktur folder
```
HIROBOT
├── lib
│   ├── ai/
│   │   ├── mcp.js          # otak AI agent + tool loader
│   │   └── tools/*.js      # semua tool AI (lihat §4.2)
│   ├── scraper/*.js        # scraper per-platform (tiktok, ig, x, ytdl, dst)
│   ├── config.js           # global.settings (owner/mods/tier/pesan default)
│   ├── connection.js       # koneksi Baileys
│   ├── converter.js        # convert media (via ffmpeg dsb)
│   ├── database.js         # database manager (json/mongo/mysql/sqlite)
│   ├── handler.js          # event handler
│   ├── helper.js           # util umum (jadi sumber banyak global, lihat §4.1)
│   ├── main.js             # tunnel, semua interval, global bootstrap
│   ├── plugins.js          # plugin loader + hot reload
│   ├── server.js           # website endpoint
│   ├── simple.js           # ekstensi method di object conn
│   ├── sticker.js          # sticker builder
│   ├── start.js            # supervisor/entrypoint (`node .`)
│   └── views/*.html        # halaman website
├── data/                   # sessions, database json, tmp, tunnel data (JANGAN di-commit)
├── plugins/                # semua command bot, per kategori folder
│   ├── ai/ group/ sticker/ dl/ owner/ tools/ main/ subbot/ _event/
├── .env                    # token asli — JANGAN DISENTUH
├── .env.example            # template env — edit di sini kalau perlu var baru
├── package.json
├── README.md
└── UPDATE_LOG              # riwayat perubahan manual (lihat juga CHANGELOG.md §2)
```

---

## 4. Function & Global yang Tersedia

### 4.1. Global variables
Sebagian besar global di-set lewat `Object.assign(global, { ...Helper, timestamp:
{ start: Date.now() } })` di `lib/main.js` (jadi semua export dari `lib/helper.js` otomatis
jadi global juga), plus beberapa di-set manual di tempat lain:

| Global | Asal | Isi |
|---|---|---|
| `global.settings` | `lib/config.js` | owner/mods list, ai (thinking/autoheal), subbot config, tier, pesan default (`msg.rowner`, dst) |
| `global.readmore` | `lib/config.js` | karakter invisible buat "read more" WA |
| `global.db` | `lib/handler.js` | instance database aktif (`db.data.users/chats/stats/msgs/settings`) |
| `global.opts` | `lib/helper.js` (via Object.assign) | hasil parse CLI args (`--self`, `--pconly`, `--gconly`, `--swonly`, `--queue`, `--noprint`, `--autoread`, `--restrict`, `--nyimak`, dst) |
| `global.prefix` | `lib/helper.js` (via Object.assign) | RegExp prefix command aktif |
| `global.__filename/__dirname/__require/checkFileExists/saveStreamToFile/isReadableStream/importFile` | `lib/helper.js` | util filesystem/module (lihat §4.3) |
| `global.timestamp` | `lib/main.js` | `{ start, connect }` — waktu proses & waktu koneksi WA connect |
| `global.support` | `lib/main.js` | `{ ffmpeg, ffprobe, ffmpegWebp, find }` — path/status binary media tools |
| `global.tunnel` | `lib/main.js` | state Cloudflare tunnel `{ proc, url, pid, reused, static, named }` |
| `global.websiteState` | `lib/main.js` | `{ mode, url }` mode publik website |
| `global.getServerUrl()` | `lib/main.js` | fungsi ambil URL publik aktif |
| `global.startTunnel` / `global.restartTunnel` | `lib/main.js` | kontrol manual tunnel |
| `global.activeIntervals` | `lib/main.js` | `Set` semua `setInterval` aktif (buat cleanup) |
| `global.server` | `lib/server.js` | instance HTTP server |
| `global.ephemeral` | dipakai di `simple.js` | durasi ephemeral message default |
| `global.img` | `plugins/_event/system.js` | cache/state terkait gambar |
| `global.igDownloadState` / `global.pinterestDlState` | plugin terkait | state sesi download multi-step |
| `global.dfail` | `lib/handler.js` | `async (type, m, conn)` — helper kirim pesan gagal standar |
| `global.gc` | Node.js (`--expose-gc`) | manual garbage collection trigger (dipakai di memory watchdog) |

### 4.2. Tool AI (`lib/ai/tools/*.js`)
Semua tool ini dipanggil oleh AI Agent bot (Gemini) lewat function-calling di `lib/ai/mcp.js`.
Setiap tool berupa `{ name, description, parameters, execute }`, di-load otomatis oleh
`loadToolsDir` — tinggal tambah file baru di folder ini untuk register tool baru.

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

### 4.3. Helper/function penting dari `lib/ai/mcp.js` (dipakai oleh tool files)
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

-- Context helper (dipakai di dalam tool files) --
ctx() -> { currentJid, conn, isOwner, isROwner, timezone, ... } (selalu fresh)
```
Catatan penting: `mcp.js` **tidak pernah** static-import file di `./tools` (di-load dinamis
lewat `loadToolsDir`), jadi tool file boleh `import { ctx, ... } from '../mcp.js'` di top-level
tanpa masalah circular import.

### 4.4. Function penting di `conn` (dari `lib/simple.js`, dipatch ke object Baileys)
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
Detail lengkap tiap fungsi + contoh ada di `README.md` (bagian "Send Message").

### 4.5. Helper umum (`lib/helper.js`, default export `Helper`)
```
Helper.__filename(pathURL, rmPrefix?) / Helper.__dirname(pathURL)
Helper.__require(dir?) / Helper.checkFileExists(file)
Helper.saveStreamToFile(stream, file) / Helper.isReadableStream(stream)
Helper.importFile(module)   // dynamic import dengan cache-busting by file hash
Helper.opts / Helper.prefix // sama seperti global.opts / global.prefix
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
Model Gemma dipakai juga secara internal untuk **auto-heal** (lihat §5.7), bukan cuma dipanggil
manual lewat command.

---

## 5. Detail Teknis Modul Lain di `lib/`

### 5.1. `lib/connection.js`
Wrapper di atas Baileys (`makeWASocket`) untuk koneksi bot utama. Yang perlu diketahui:
- Support **pairing code** (termasuk custom pairing via env `CUSTOM_PAIRING`, harus 8 karakter)
  maupun **QR code** — fallback otomatis kalau salah satu gagal.
- Ada **connection watchdog** (`global._optikWatchdog`, `setInterval`) yang memantau status
  socket dan auto-reconnect kalau putus, dengan penanganan khusus untuk `DisconnectReason`
  (loggedOut vs restartRequired vs error biasa).
- `global.timestamp.connect` diisi begitu socket berhasil connect.
- Dipakai ulang oleh `plugins/subbot/connect.js` untuk multi-session (subbot), lihat §5.6.

### 5.2. `lib/database.js` — Multi-adapter Database
Default: **JSON lokal** (`data/*.json`, di-load lewat `database.read()/write()`, di-wrap `lodash`
via `database.chain`). Bisa diganti lewat env `DATABASE` ke salah satu:
- `MongoDBV2` / `mongoDB` — MongoDB (butuh package `mongoose`, di-lazy-install otomatis kalau
  belum ada di `node_modules`).
- `MySqlAdapter` — MySQL, format URL: `jdbc:mysql://user:pass@host:port/database`.
- `SQLiteAdapter` — pakai `node:sqlite` built-in Node.js.
- `CloudDBAdapter` — adapter cloud custom.

Semua adapter diakses lewat interface yang sama (`database.data`, `database.read()`,
`database.write()`), jadi kode lain (plugin/tool AI) **tidak perlu tahu** adapter mana yang
aktif — selalu akses lewat `global.db` / `db.data.{users,chats,stats,msgs,settings}`.

**Struktur `db.data` (skema utama):**
```
db.data.users  = { [jid]: { name, exp, limit, premium, premiumTime, level, registered, ... } }
db.data.chats  = { [jid]: { welcome, isBanned, aiEnabled?, ... } }
db.data.stats  = { [key]: number }   // command usage stats
db.data.msgs   = { [key]: object }   // pesan tersimpan (dbmsg tools: get/add/del/list vn/msg/img/dst)
db.data.settings = { ... }           // pengaturan global tambahan
```
Website (`lib/server.js`) juga baca/tulis ke `db.data.users` untuk sistem **register/login/OTP,
tier, EXP, gems, gift code, premium** — lihat §5.3.

### 5.3. `lib/server.js` — Website & REST API
Selain serve static file dari `lib/views/*.html`, `server.js` juga mengekspos **REST API** (di
bawah `/api/*`) yang menjalankan dashboard web bot (login/register user, profil, tier system,
gift code, dsb). Route dibuat lewat helper `get(path, handler)` / `post(path, handler)` di
`buildRoutes(conn)`. Endpoint yang ada saat ini:

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/health` | health check |
| GET | `/api/tierAsset` | asset/label tier |
| GET | `/api/botInfo` | info umum bot (nama, icon, dst) |
| GET | `/api/commandList` | daftar command (sumber sama dengan `.menu`) |
| GET | `/api/envExample` | isi `.env.example` (bukan `.env` asli!) |
| POST | `/api/register` | registrasi akun website |
| POST | `/api/login` | login |
| POST | `/api/verify-otp` / `/api/resend-otp` | verifikasi OTP |
| GET | `/api/profile` | data profil user (exp, tier, limit, dst) |
| POST | `/api/daily` | klaim reward harian |
| POST | `/api/tierup` | naik tier |
| POST | `/api/change-password` / `/api/rename` | update akun |
| POST | `/api/redeem` | redeem gift code |
| POST | `/api/buy-limit` / `/api/buy-premium` | beli limit/premium pakai gems |
| POST | `/api/slot` | fitur slot/gacha (gems) |
| GET | `/api/gems` | saldo gems |
| POST | `/api/logout` | logout |
| GET | `/api/check-owner` | cek apakah request dari owner |
| GET/POST | `/api/admin/giftcodes*` | CRUD gift code (admin only) |
| GET | `/api/premium-notice` | notifikasi status premium |
| GET | `/api/user-search` / `/api/admin/users` | cari/list user (admin) |
| POST | `/api/admin/update-user` / `/api/admin/delete-user` | kelola user (admin) |
| POST | `/api/check-number` | cek nomor WA terdaftar/tidak |

- Route non-`/api/` (`GET`) di-serve sebagai **static file** dari `lib/views/` (`index.html`,
  `profile.html`).
- Ada **WebSocket server** (`WebSocketServer`) yang nge-pipe semua event dari `conn` (koneksi
  Baileys) ke client browser secara real-time (prefix `conn-`), dipakai buat live status di
  website (mis. tampilkan QR/pairing code tanpa refresh).
- Ada rate-limit sederhana in-memory (`checkMemoryRateLimit`) khusus untuk semua path `/api/*`.
- **Jangan** expose data sensitif (password hash, token) lewat endpoint manapun — ikuti pola
  yang sudah ada (password selalu di-hash, OTP punya expiry).

### 5.4. `lib/sticker.js`
Export: `sticker(...)` (bikin file `.webp` dari image/video buffer, dipakai plugin
`sticker.js`, `brat.js`, dll) dan `addExif(...)` (nulis metadata pack-name/author ke webp sticker,
dipakai `setwm.js`, dsb).

### 5.5. `lib/converter.js`
Export: `toAudio`, `toPTT`, `toVideo`, `ffmpeg` (dan util terkait) — semua konversi media
berbasis `fluent-ffmpeg`, dipakai plugin `tools/convert.js` dan berbagai downloader.

### 5.6. Sistem Subbot (`plugins/subbot/*`)
Bot ini support **multi-session** — user bisa hubungkan nomor WA mereka sendiri sebagai
"subbot" yang ikut nempel ke instance bot utama:
- `.pairing` / `.connect` / `.reconnect` / `.disconnect` (`plugins/subbot/connect.js`) — bikin
  session baru pakai `makeWASocket` terpisah, disimpan di
  `data/sessions/subbot/<id>` (`settings.subbot.path`), dibatasi
  `settings.subbot.maxConnect` (default 3) session aktif bersamaan, dan
  `settings.subbot.autoConnect` untuk auto-reconnect subbot yang sudah pernah connect saat bot
  utama restart.
- `.listsubbot` (`plugins/subbot/list.js`) — lihat subbot yang aktif.

### 5.7. Sistem AI lanjutan (di `lib/ai/mcp.js`)
- **Model routing**: command `.ai`, `.ai:flash`, `.ai:pro`, `.ai:gemma`, `.ai:gemma-moe`
  (regex `/^ai(:[a-z-]+)?$/i` di `plugins/ai/ai.js`) — suffix setelah `:` dipetakan ke
  `MODELS` (§4.6). Model **Gemma** (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) **tidak** punya
  akses tool-calling/search sama sekali (murni reasoning/coding text), beda dari Gemini
  (`default`, `flash`, `pro`) yang full tool-calling.
- **Thinking mode**: dikontrol `global.settings.ai.thinking` (di `lib/config.js`). Kalau
  `true`, request ke Gemini pakai `thinkingConfig: { thinkingBudget: -1 }` (dynamic thinking)
  dan progress step ("Sedang berpikir...") dikirim live ke chat lewat `opts.onStep`. Tidak
  berlaku untuk model Gemma (tidak support thinkingConfig).
- **Auto-heal**: dikontrol `global.settings.ai.autoheal` (default `false`) + bisa dimatikan
  paksa lewat env `DISABLE_AUTO_HEAL=true`. Alur (`handleError` di `mcp.js`, dipanggil dari
  `lib/handler.js` tiap ada error di plugin):
  1. Kalau error itu **disengaja** (plugin memang `throw new Error("pesan validasi")`) atau
     **transient/downstream API error** (rate limit, API pihak ketiga down) → auto-heal
     **di-skip**, cuma kirim pesan biasa ke user (tidak dianggap bug).
  2. Kalau bug beneran & auto-heal aktif → bot kirim status "Auto-fix in progress..." ke
     chat, lalu model **Gemma** dipanggil untuk coba analisa & perbaiki source file yang
     error (`findSourceFiles(err)`), dengan **cooldown 5 menit** per error-key supaya tidak
     spam retry pada error yang sama berulang-ulang.
  3. Kalau auto-heal mati/disabled → cuma laporkan error ke owner (dengan detail) atau ke user
     biasa (pesan generik "Something went wrong").
- **Rate limit & API key pool**: `AI_KEYS` di `.env` bisa berupa 1 key (string) atau banyak key
  (JSON array) untuk fallback — `getNextKey()/rotateKey()` otomatis pindah key kalau kena limit,
  `resetRateLimit(jid)` reset limit per-chat.

---

## 6. Daftar Plugin per Kategori (command trigger)
Sumber kebenaran tetap `list_plugins`/`.menu` saat runtime (bisa berubah kalau ada plugin baru),
tapi berikut snapshot command yang ada di repo ini per kategori folder:

| Kategori (`plugins/<folder>/`) | Command |
|---|---|
| `main/` | `menu`/`help`/`?`, `ping`/`speed`, `profile`, `daftar`/`register`, `owner`/`creator`, `speedtest`, `enable`/`disable`/`on`/`off` |
| `ai/` | `ai`/`ai:<model>`, `aicheck`, `gpt`, `mistral`, `pollination` |
| `group/` | `add`, `groups`/`grouplist`, `groupinfo`/`infogroup`/`infogc`, `linkgroup`, `group` (open/close), `promote`, `setwelcome`/`setbye`, `simulate` |
| `sticker/` | `sticker`/`s`/`stickergif`/`stickerwm`, `brat`/`bratvid`, `sprem`, `setwm`, `wm`, `smeta`, `telesticker`/`stickertele`/`stele` |
| `dl/` (downloader) | `spotify`, `yt`/`play`/`ytv`/`ytaudio`/`ytsearch`, `tt`/`tiktok`(`audio`), `ig`/`instagram`/`igdl`, `fb`/`facebook`/`fbdl`, `x`/`twitter`, `reddit`/`redditdl`, `pinterest`/`pint`, `mediafire`/`mf`, `gdrive`/`gd`, `e621`, `animein`, `ph`/`pornhub` |
| `owner/` | `backup`, `gitpush`/`gitstats`, `restart`, `setbotpp`, `grep <keyword>`, `save*`/`getplugin`/`gp` (file.js), eval prefix `<`/`<<`/`$ ` (exec.js, **rowner only**) |
| `tools/` | `toimg`/`tovideo`/`tovn`/`toptt`/`tomp3`/`toaudio`, `resize`, `hd`/`upscale`, `imgmotion`, `ssweb`, `tourl`/`upload`, `getexif`, `fetch`/`get`, `delete`, `readviewonce`/`rvo`, `get/add/del/list` + `vn/msg/video/audio/img/sticker/gif` (dbmsg.js) |
| `subbot/` | `pairing`/`connect`/`reconnect`/`disconnect`, `listsubbot`/`listbot` |
| `_event/` | Bukan command biasa — event hook internal: `system.js` (welcome/leave, dsb), `getmsg.js`, `buttonResponse.js` (handle klik native-flow button) |

## 7. Referensi Lengkap Environment Variables (`.env.example`)
| Var | Wajib? | Keterangan |
|---|---|---|
| `BOT_NAME` | **Wajib** | Nama bot, dipakai di system prompt AI & UI |
| `OWNER` / `MODERATOR` | Opsional (default kosong) | JSON array `[["628xxx","Nama",true], ...]` |
| `CUSTOM_PAIRING` | Opsional | Kode pairing custom, maks 8 karakter |
| `GROUP_ID` | Opsional | Untuk LID solver, isi invite link atau group JID |
| `DISCORD_WEBHOOK` | Opsional | Dipakai `plugins/tools/upload.js` |
| `SPOTIFY_TOKEN` | Opsional | Fallback `client_id:client_secret` kalau anonymous Spotify kena 429 |
| `AI_PERSONALITY` | Opsional | Override `DEFAULT_PERSONALITY` di `mcp.js` |
| `AI_KEYS` | **Wajib untuk fitur AI** | 1 key (string) atau banyak (JSON array), dari aistudio.google.com |
| `GIT_CLASSIC_KEY` / `GIT_TOKEN` / `GIT_USER` / `GIT_EMAIL` / `GIT_REPO` | Opsional (dev/fork saja) | Kredensial untuk `.gitpush` |
| `DATABASE` | Opsional | Kosong = JSON lokal; isi untuk pakai MySQL/MongoDB/SQLite/Cloud adapter |
| `CLOUDFLARE_TUNNEL_TOKEN` / `CLOUDFLARE_TUNNEL_HOSTNAME` | Opsional | Custom domain lewat Cloudflare Tunnel |
| `HOSTNAME_PUBLIC` | Opsional | Hostname publik kalau tidak pakai tunnel |
| `DISABLE_AUTO_HEAL` | Opsional (tidak ada di `.env.example`, tapi dibaca kode) | `"true"` untuk matikan auto-heal paksa |

**Aturan tambahan**: kalau ada kebutuhan var baru, tambahkan ke `.env.example` dengan value
kosong/placeholder + komentar penjelasan (ikuti gaya yang sudah ada), **jangan pernah** isi
`.env.example` dengan value asli/rahasia.

---

## 8. Ringkasan Cepat (TL;DR)
- Jangan sentuh `.env`, hanya `.env.example`.
- Sebelum `gitpush`: cek `.git` → cek file berubah → cek isi perubahan → update
  `CHANGELOG.md` → baru commit & push.
- Jangan ubah system prompt AI Agent (`lib/ai/mcp.js`) atau gating risk tool tanpa diminta.
- Plugin baru ikuti 4 format standar di §3.3, taruh di folder `plugins/<kategori>/`.
- Tool AI baru taruh di `lib/ai/tools/`, ikuti pola `{ name, description, parameters, execute }`.
- Semua global tersedia tanpa import (lihat §4.1) — cek dulu sebelum re-implement hal yang
  sudah ada.
