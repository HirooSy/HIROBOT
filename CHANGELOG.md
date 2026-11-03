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

<h3>29/October/2026</h3>
<sub>

```diff
• Clean up unused Discord and WhatsApp plugin files to streamline project structure
• Refactor AI tools and handler utilities to improve message processing and command execution
• Update website server, scrapers, and core helper functions for enhanced performance

________________________

* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/ai/tools/group.js"
* Edit "lib/package/ai/tools/html.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/package/ai/tools/messaging.js"
* Edit "lib/package/ai/tools/plugin.js"
* Edit "lib/package/ai/tools/readchat.js"
* Edit "lib/package/ai/tools/reminder.js"
* Edit "lib/package/ai/tools/system.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/animein.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/scrapers/src/ezgif.js"
* Edit "lib/scrapers/src/facebook.js"
* Edit "lib/scrapers/src/ig.js"
* Edit "lib/scrapers/src/nano.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/tiktok.js"
* Edit "lib/scrapers/src/upload.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/scrapers/src/ytsearch.js"
* Edit "lib/utils/canvas.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/converter.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
- Delete "plugins/discord"
- Delete "plugins/whatsapp"
```
</sub>

<h3>24/October/2026</h3>
<sub>

```diff
• Massive project refactor: migrated all plugins to commands structure, modernized handler, and significantly updated website server and scraper modules
• Clean up unused plugins and optimize project structure
• Update README.md with Discord-WhatsApp bridge documentation
• Cleanup and minor refinement of Discord profile and core handler logic

________________________

* Edit ".env.example"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/package/website/views/style.css"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/tiktok.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/scrapers/src/ytdl.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/converter.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
+ Add "plugins/discord"
+ Add "lib/package/discord/"
+ Add "lib/package/website/views/connect.html"
+ Add "lib/utils/print.js"
```
</sub>

<h3>17/October/2026</h3>
<sub>

```diff
• Translate logs, error messages, and UI text from Indonesian to English
• Update baileys dependency to v0.3.3
• Refine baileys update logic and cloudflared tunnel logging

________________________

* Edit "lib/main.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/messaging.js"
* Edit "lib/scrapers/src/ai-image.js"
* Edit "lib/scrapers/src/nano.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/tiktok.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/start.js"
* Edit "lib/utils/canvas.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/converter.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/ai/aicheck.js"
* Edit "plugins/ai/notrack.js"
* Edit "plugins/dl/drive.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/tt.js"
* Edit "plugins/dl/x.js"
* Edit "plugins/dl/yt.js"
* Edit "plugins/group/add.js"
* Edit "plugins/group/fakemsg.js"
* Edit "plugins/group/link.js"
* Edit "plugins/group/promote.js"
* Edit "plugins/group/setwelcome.js"
* Edit "plugins/group/simulate.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/main/profile.js"
* Edit "plugins/main/speedtest.js"
* Edit "plugins/sticker/telegram.js"
* Edit "plugins/tools/alightmotion.js"
* Edit "plugins/tools/convert.js"
* Edit "plugins/tools/crm.js"
* Edit "plugins/tools/dbmsg.js"
* Edit "plugins/tools/exif.js"
* Edit "plugins/tools/hd.js"
* Edit "plugins/tools/reaction.js"
* Edit "plugins/tools/wink.js"
```
</sub>