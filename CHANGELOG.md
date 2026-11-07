<h3>07/November/2026</h3>
<sub>

```diff
• Refactor global.settings.icon into global.settings.website object with icon, thumbnail, and description properties
• Add dynamic OpenGraph and Twitter meta tag injection for website server responses
• Implement WebSocket connection authorization callback handling in WebSocketServer
• Increase random upload filename generation length to 20 bytes for enhanced uniqueness
• Add strict 64-character hex format validation for authorization bearer tokens
• Extract view scripts from connect, index, and profile templates into external assets directory
• Update handler order message thumbnail references to global.settings.website.icon

________________________

+ Add "lib/package/website/views/assets/connect-1.js"
+ Add "lib/package/website/views/assets/index-1.js"
+ Add "lib/package/website/views/assets/index-2.js"
+ Add "lib/package/website/views/assets/index-3.js"
+ Add "lib/package/website/views/assets/index-4.js"
+ Add "lib/package/website/views/assets/profile-1.js"
* Edit "lib/config.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/connect.html"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/utils/handler.js"
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

<h3>01/November/2026</h3>
<sub>

```diff
• Add pure JS Chrome/Playwright browser automation module package
• Add sticker reaction support and payload handling to react helper methods
• Add username resolution fallback to LID-to-number mapping resolution
• Update internal plugin documentation and structure guide
• Add proxy cache limits and cleanup to website server
• Refactor brat and converter plugins to use safe execFile with timeout/quiet flags
• Refactor Pornhub downloader with temp cleanup, improved session management, and safe ffmpeg flags
• Add search cache pruning limit to Spotify plugin

________________________

+ Add "lib/package/chrome/browser.js"
+ Add "lib/package/chrome/challenge.js"
+ Add "lib/package/chrome/context.js"
+ Add "lib/package/chrome/dom.js"
+ Add "lib/package/chrome/engine/"
+ Add "lib/package/chrome/errors.js"
+ Add "lib/package/chrome/index.js"
+ Add "lib/package/chrome/input.js"
+ Add "lib/package/chrome/launcher.js"
+ Add "lib/package/chrome/launcher.js"
+ Add "lib/package/chrome/locator.js"
+ Add "lib/package/chrome/messages.js"
+ Add "lib/package/chrome/network.js"
+ Add "lib/package/chrome/page.js"
+ Add "lib/package/chrome/recaptcha.js"
+ Add "lib/package/chrome/solver.js"
+ Add "lib/package/chrome/stealth.js"
+ Add "lib/package/chrome/transport.js"
+ Add "lib/package/chrome/util.js"
* Edit "README.md"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/tools/reaction.js"
* Edit "lib/package/ai/toold/plugin.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/utils/converter.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/dl/spotify.js"
```
</sub>

<h3>31/October/2026</h3>
<sub>

```diff
• Refactor and restructure canvas plugin and categories
• General project refactoring and cleanup of scrapers and utilities for enhanced stability

________________________

+ Add "lib/package/axios.js"
+ Add "lib/package/canvas.js"
+ Add "lib/package/cheerio.js"
- Delete "lib/utils/canvas.js"
* Edit "lib/package/ai/platform.js"
* Edit "lib/package/ai/tools/plugin.js"
* Edit "lib/package/discord/payload.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/ai-image.js"
* Edit "lib/scrapers/src/animein.js"
* Edit "lib/scrapers/src/apkpure.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/scrapers/src/e621.js"
* Edit "lib/scrapers/src/ezgif.js"
* Edit "lib/scrapers/src/facebook.js"
* Edit "lib/scrapers/src/ig.js"
* Edit "lib/scrapers/src/nano.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/tiktok.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/scrapers/src/ytsearch.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/converter.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/ai/aicheck.js"
* Edit "plugins/ai/bing.js"
* Edit "plugins/ai/gpt.js"
* Edit "plugins/ai/notrack.js"
* Edit "plugins/ai/pollination.js"
* Edit "plugins/dl/drive.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/mediafire.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/dl/shinigami.js"
* Edit "plugins/dl/spotify.js"
* Edit "plugins/dl/yt.js"
* Edit "plugins/group/role.js"
* Edit "plugins/main/profile.js"
* Edit "plugins/owner/files.js"
* Edit "plugins/owner/setpp.js"
* Edit "plugins/sticker/telegram.js"
* Edit "plugins/tools/alightmotion.js"
* Edit "plugins/tools/fetch.js"
* Edit "plugins/tools/hd.js"
* Edit "plugins/tools/iloveimg.js"
* Edit "plugins/tools/reaction.js"
* Edit "plugins/tools/removebg.js"
* Edit "plugins/tools/resize.js"
* Edit "plugins/tools/ssweb.js"
* Edit "plugins/tools/wink.js"
```
</sub>