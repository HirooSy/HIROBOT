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
* Edit "lib/scrapers/src/brat.js"
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
* Edit "plugins/ai/gpt.js"
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
* Edit "plugins/sticker/sticker.js"
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

<h3>16/October/2026</h3>
<sub>

```diff
• Fix Native SQL bloated issue (please update baileys version)
• Fix Gemini guest's (keyless version) tool vision to video/audio
• Add auto update baileys version in main.js
• Some minor changes 
• Add ability to AI to react facebook contents
________________________

* Edit lib/main.js
* Edit lib/package/ai/mcp.js
* Edit lib/package/ai/prompt.txt
* Edit lib/package/ai/tools/files.js
* Edit lib/package/ai/tools/group.js
* Edit lib/package/ai/tools/media.js
* Edit lib/package/ai/tools/messaging.js
* Edit lib/package/ai/tools/plugin.js
* Edit lib/package/ai/tools/reminder.js
* Edit lib/package/ai/tools/system.js
* Edit lib/package/ai/tools/web.js
* Edit lib/scrapers/src/x.js
* Edit lib/scrapers/src/ytdl.js
* Edit lib/utils/database.js
* Edit plugins/ai/aicheck.js
* Edit plugins/ai/notrack.js
* Edit plugins/dl/x.js
```
</sub>

<h3>15/October/2026</h3>
<sub>

```diff
• Implement robust path resolution and security checks for AI file operations to prevent arbitrary access outside project root (https://github.com/HirooSy/HIROBOT/pull/6)
• Refactor connection settings to enable history loading by default
• Remove channel management plugin
• Refactor tiered configuration settings to improve capacity tracking
• Cleanup unused constants and refine error threshold logic in connection main.js
• Refactor web server infrastructure and routes
• Remove legacy creator plugin
• Add new owner contact plugin

________________________

* Edit "lib/config.js"
* Edit "lib/package/ai/tools/files.js"
- Delete "plugins/tools/channel.js"
+ Add "plugins/main/channel.js"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/website/server.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
- Delete "plugins/main/creator.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/main/profile.js"
+ Add "plugins/main/owner.js"
```
</sub>

<h3>15/October/2026</h3>
<sub>

```diff
• Implement upload fallback from Savedly to local server in upload scraper
• Update upload plugin to incorporate fallback mechanism and improved status handling
• Add Sticker.ly scraper for search and fetching sticker packs
• Add Stickerly plugin to search and download sticker packs

________________________

* Edit "lib/scrapers/src/upload.js"
* Edit "plugins/tools/upload.js"
+ Add "lib/scrapers/src/stickerly.js"
+ Add "plugins/sticker/stickerly.js"
```
</sub>

<h3>14/October/2026</h3>
<sub>

```diff
• Refactor reload system to include syntax checking before restart and improved library debouncing
• Enhance GeminiGuest streaming with robust JSON parsing and improved error handling for quota/auth issues
• Add image generation support via GeminiGuest and update scraper structures
• Improve hot-reload efficiency by excluding scraper source directories and adding better watcher management
• Refactor database engine with complex adapter system (MongoDB, SQL) and auto-compaction
• Update bot startup and connection routines for stability
________________________

* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/package/ai/tools/web.js"
* Edit "lib/scrapers/index.js"
* Edit "lib/scrapers/src/ai-image.js"
* Edit "lib/start.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
+ Add "plugins/tools/stabilize.js"
```
</sub>

