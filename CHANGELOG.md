<h3>15/November/2026</h3>
<sub>

```diff
• Add isGroupTarget helper in simple.js to restrict hidden message delivery handling strictly to group chats
• Simplify native flow node construction by removing redundant biz_bot tag attachment on non-group targets

________________________

* Edit "lib/utils/simple.js"
```
</sub>

<h3>14/November/2026</h3>
<sub>

```diff
• Add SPR message tool plugin for targeted hidden message delivery
• Add SoundCloud, Threads and TV stream channel scraper modules and plugins
• Refactor VoIP call engine, media sessions, and relay handlers for enhanced WebRTC call handling
• Update Discord module payload handling, permissions, text, and voice options
• Refactor handler, connection, database, and simple core utilities
• Update web server dashboard views and API route handling
• Update Spotify and Telegram scraper modules along with various group and downloader plugins
• Fix sequence gap calculation logic in VoIP media session packet receiver and remove unused footer constant in WhatsApp music controls

________________________

+ Add "lib/scrapers/src/soundcloud.js"
+ Add "lib/scrapers/src/threads.js"
+ Add "lib/scrapers/src/tv.js"
+ Add "plugins/dl/soundcloud.js"
+ Add "plugins/dl/threads.js"
+ Add "plugins/internet/tv.js"
+ Add "plugins/tools/spr.js"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/discord/opus.js"
* Edit "lib/package/discord/payload.js"
* Edit "lib/package/discord/permissions.js"
* Edit "lib/package/discord/text.js"
* Edit "lib/package/discord/voice.js"
* Edit "lib/package/voip/app-data/WaAppDataStream.js"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/package/voip/media/mlow-codec.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/dtls/handshake.js"
* Edit "lib/package/voip/relay/relay-ack.js"
* Edit "lib/package/voip/relay/sctp/association.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/types.js"
* Edit "lib/package/voip/voipClient.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/connect.html"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/spotify.js"
* Edit "lib/scrapers/src/telegram.js"
* Edit "lib/utils/botsManager.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/print.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/dl/apkpure.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/sfile.js"
* Edit "plugins/group/ban.js"
* Edit "plugins/group/kick.js"
* Edit "plugins/group/nickname.js"
* Edit "plugins/group/role.js"
* Edit "plugins/group/slowmode.js"
* Edit "plugins/main/play.js"
* Edit "plugins/main/profile.js"
* Edit "plugins/owner/call.js"
* Edit "plugins/sticker/telegram.js"
```
</sub>

<h3>07/November/2026</h3>
<sub>

```diff
• Refactor global.settings.icon into global.settings.website object with icon, thumbnail, and description properties
• Add dynamic OpenGraph and Twitter meta tag injection for website server responses
• Implement WebSocket connection authorization callback handling in WebSocketServer
• Increase random upload filename generation length to 20 bytes for enhanced uniqueness
• Add strict 64-character hex format validation for authorization bearer tokens
• Inline page view scripts back into templates and implement dynamic script externalization in server with SHA-1 hashing and immutable `/_p/:hash.js` endpoint caching
• Update handler order message thumbnail references to global.settings.website.icon
• Extract inline scrapers across AI, downloader, internet, sticker, and tool plugins into dedicated modules in `lib/scrapers/src/`
• Add standalone plugins and scraper modules for DeepAI, DeepSeek, Sfile downloader, Lyrics search, and InboxKitten
• Update README branding images, header layout, and Baileys-lite badge

________________________

+ Add "lib/scrapers/src/aicheck.js"
+ Add "lib/scrapers/src/deepai.js"
+ Add "lib/scrapers/src/deepseek.js"
+ Add "lib/scrapers/src/discordstalk.js"
+ Add "lib/scrapers/src/drive.js"
+ Add "lib/scrapers/src/gpt.js"
+ Add "lib/scrapers/src/hd.js"
+ Add "lib/scrapers/src/iloveimg.js"
+ Add "lib/scrapers/src/inboxkitten.js"
+ Add "lib/scrapers/src/lyrics.js"
+ Add "lib/scrapers/src/mediafire.js"
+ Add "lib/scrapers/src/notrack.js"
+ Add "lib/scrapers/src/pollination.js"
+ Add "lib/scrapers/src/pornhub.js"
+ Add "lib/scrapers/src/reddit.js"
+ Add "lib/scrapers/src/removebg.js"
+ Add "lib/scrapers/src/sfile.js"
+ Add "lib/scrapers/src/shinigami.js"
+ Add "lib/scrapers/src/speedtest.js"
+ Add "lib/scrapers/src/spotify.js"
+ Add "lib/scrapers/src/ssweb.js"
+ Add "lib/scrapers/src/telegram.js"
+ Add "lib/scrapers/src/tinyurl.js"
+ Add "lib/scrapers/src/wink.js"
+ Add "plugins/ai/deepai.js"
+ Add "plugins/ai/deepseek.js"
+ Add "plugins/dl/sfile.js"
+ Add "plugins/internet/lyrics.js"
+ Add "plugins/tools/inboxkitten.js"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/connect.html"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/e621.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/utils/handler.js"
* Edit "plugins/ai/aicheck.js"
* Edit "plugins/ai/gpt.js"
* Edit "plugins/ai/notrack.js"
* Edit "plugins/ai/pollination.js"
* Edit "plugins/dl/drive.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/mediafire.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/dl/reddit.js"
* Edit "plugins/dl/shinigami.js"
* Edit "plugins/dl/spotify.js"
* Edit "plugins/internet/discordstalk.js"
* Edit "plugins/main/speedtest.js"
* Edit "plugins/sticker/telegram.js"
* Edit "plugins/tools/alightmotion.js"
* Edit "plugins/tools/hd.js"
* Edit "plugins/tools/iloveimg.js"
* Edit "plugins/tools/removebg.js"
* Edit "plugins/tools/ssweb.js"
* Edit "plugins/tools/tinyurl.js"
* Edit "plugins/tools/wink.js"
```
</sub>

<h3>06/November/2026</h3>
<sub>

```diff
• Add text_to_speech AI tool for converting text to spoken audio via Gemini TTS and sending as voice notes
• Implement Gemini TTS helper geminiSpeech in MCP package with voice settings, style options, and API key cooldowns
• Support TTS fallback across multiple Gemini models and update speech generation API handling in MCP package
• Refactor hot-reload module to dynamically reload config.js changes without requiring a full process restart
• Refactor reload watcher helper functions, ignore temporary swap files, and schedule process restarts
• Add global.settings.ai.voice configuration option in config.js for default text-to-speech voice settings
• Update AI message handler to alternate message quoting behavior when replying
• Update AI_KEYS configuration documentation in .env.example and README.md for comma-separated API keys
• Update README.md documentation with Gemini Guest vs API key capability matrix

________________________

* Edit ".env.example"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/utils/reload.js"
* Edit "plugins/ai/ai.js"
```
</sub>

<h3>05/November/2026</h3>
<sub>

```diff
• Restrict channel upchannel command execution strictly to bot owners with global.dfail authorization
• Add Discord profile connections and snapshot data caching upon Discord OAuth login
• Improve large API response handling in fetch tool by sending as document attachment
• Refactor CRM helper functions and base64/data URI string formatting logic
• Improve conn.getName() contact name resolution by merging contact data from LID and JID mappings

________________________

+ Add "lib/scrapers/src/igstalk.js"
+ Add "lib/scrapers/src/ocr.js"
+ Add "lib/scrapers/src/roblox.js"
+ Add "plugins/internet/discordstalk.js"
+ Add "plugins/internet/igstalk.js"
+ Add "plugins/internet/robloxstalk.js"
+ Add "plugins/tools/ocr.js"
* Edit "lib/package/website/server.js"
* Edit "plugins/main/channel.js"
* Edit "plugins/tools/crm.js"
* Edit "plugins/tools/fetch.js"
* Edit "lib/utils/simple.js"
```
</sub>

<h3>03/November/2026</h3>
<sub>

```diff
• Add status broadcast plugin for uploading photos, videos, and text directly to WhatsApp status
• Add subbot API endpoints and control panel UI for custom prefix and menu settings management
• Enhance subbot menu handler to support custom menu templates and placeholder replacements
• Add sendButtonTemplate helper and quick reply button-v2 support (up to 3 buttons) for subbot menu
• Add new menu placeholders (__totalUsers__, __runtime__, __timezone__) across menu handlers and web UI
• Update baileys dependency to ^0.3.7 and export detectTimezoneFromNumber utility
• Update README documentation for button templates and message types
• Add native Node.js SQLite (DatabaseSync) support and automatic migration for legacy database files
• Support product headers in interactive sendButton messages and rename LTO parameters to coupon
• Record relayed message history centrally in connection helper and include additionalNodes in crm code generator
• Move subbot management system from plugin into core botsManager utility
• Add subbot API endpoints and web UI controls for Auto Read, Auto Typing, and Show Online settings
• Refactor connection config to flatten main and subbot settings under global.settings.connection
• Support optionText and optionTitle parameters in interactive button builder
• Remove deprecated subbot plugin files and menu category

________________________

* Edit "README.md"
+ Add "plugins/owner/sw.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/package/website/views/style.css"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/main/menu.js"
* Edit "plugins/owner/setpp.js"
* Edit "lib/utils/database.js"
* Edit "plugins/main/enable.js"
* Edit "plugins/tools/crm.js"
* Edit "lib/config.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/handler.js"
+ Add "lib/utils/botsManager.js"
- Delete "plugins/subbot/connect.js"
- Delete "plugins/subbot/list.js"
```
</sub>

<h3>02/November/2026</h3>
<sub>

```diff
• Refactor session and database storage paths to data/bot directory
• Add subbot API management endpoints and UI for subbot type, mode, botname, and AI-assisted plugin management
• Add subbot AI plugin editing endpoint and UI integration for modifying existing subbot plugins
• Optimize web server proxy cache handling and memory management
• Export guest text generation utility in MCP AI package
• Update project documentation and file tree in README.md
• Add /api/user-profile endpoint for querying user data and badge status
• Enhance subbotActiveList to include botName and user key for better UI integration
• Add subbotDisplayName helper to subbot plugin for unified name resolution
• Update stylesheet version for profile page

________________________

* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/package/website/views/style.css"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "plugins/ai/ai.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/owner/backup.js"
* Edit "plugins/owner/migratedb.js"
* Edit "plugins/subbot/connect.js"
```
</sub>