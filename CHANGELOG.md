<h3>15/October/2026</h3>
<sub>

```diff
• Implement upload fallback from Savedly to local server in upload scraper
• Update upload plugin to incorporate fallback mechanism and improved status handling

________________________

* Edit "lib/scrapers/src/upload.js"
* Edit "plugins/tools/upload.js"
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

<h3>13/October/2026</h3>
<sub>

```diff
• Refactor Gemini MCP image upload process by replacing deprecated guest-mode endpoint with content-push API, improving reliability and MIME type handling
• Refactor font parsing logic by centralizing and enhancing font processing in canvas.js, removing legacy parsing code from brat.js
• Add support for configuring external font sources in global configuration to enable custom rendering

________________________

* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/utils/canvas.js"
```
</sub>

<h3>12/October/2026</h3>
<sub>

```diff
• Refactor animated sticker conversion in simple.js to use quality/fps fallback profiles and process priority optimization
• Update Telegram sticker plugin to prioritize TELEGRAM_BOT_TOKEN environment variable and limit video sticker pack chunks to 30

________________________

* Edit "lib/utils/simple.js"
* Edit "plugins/sticker/telegram.js"
```
</sub>

<h3>11/October/2026</h3>
<sub>

```diff
• Fix Gemini MCP turn role mapping to send 'user' role instead of 'tool' role for function response turns
• Update temporary directory paths and prompt guidance for file management tools
• Enhance canvas rendering engine in canvas.js with pure JS/WASM HTML rendering and SVG support
• Redesign profile card UI with HTML rendering and badges in profile.js
• Remove invalid .git and .gitignore rules from GitHub upload configuration in github.js

________________________

+ Add ".gitignore"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/start.js"
* Edit "lib/utils/canvas.js"
* Edit "package.json"
* Edit "plugins/main/profile.js"
* Edit "plugins/owner/github.js"
```
</sub>

<h3>09/October/2026</h3>
<sub>

```diff
• Implement dynamic site settings in profile dashboard, allowing customization of daily rewards, shop pricing, gacha symbol weights/rewards, and subbot mode constraints
• Update web server routes and add API endpoints to fetch, validate, and save customized site settings in database
• Integrate settings UI tabs, inputs, and controls inside the database section of the web dashboard
• Enhance subbot connection commands to dynamically enforce premium validation rules from active site settings

________________________

* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/package/website/views/style.css"
* Edit "plugins/subbot/connect.js"
```
</sub>

<h3>08/October/2026</h3>
<sub>

```diff
• Add new ApkPure downloader plugin and scraper utility
• Update web profile dashboard with custom pixel particle snow animation and black theme
• Refine syntax and command aliases for channel utility plugins (upch, upchannel, statsch, statschannel, statusch, statuschannel)
• General maintenance and refactoring of connection and subbot utilities
• Refactor 'generate_image' AI tool to utilize the newly implemented Bing Image Creator scraper and support rich message formatting with up to 4 images
• Rewrite text-to-image scraper from scratch using Bing Image Creator with a custom cookie jar, polling sequence, and robust user-agent spoofing to replace the deprecated guest-mode ImageGPT endpoint
• Update 'generate_image' AI tool definition and execution to dynamically support and forward user-specified aspect ratios (1:1, 3:2, 2:3)
• Modify Bing Image Creator scraper to support and parse aspect ratio parameters, mapping them to the proper query and payload indices
• Implement new 'bingImage' command plugin ('plugins/ai/bingImage.js') supporting custom ratio options with automatic text parsing and rich message fallback
• Update 'create_zip' tool to support zipping installed library directories inside 'node_modules' when explicitly specified as input paths
• Clarify zipping behavior for nested modules and parent folders in the AI system prompts

________________________

+ Add "lib/scrapers/src/apkpure.js"
+ Add "plugins/ai/bingImage.js"
+ Add "plugins/dl/apkpure.js"
+ Add "plugins/tools/channel.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/package/website/views/style.css"
* Edit "lib/scrapers/src/ai-image.js"
* Edit "lib/utils/connection.js"
* Edit "plugins/subbot/connect.js"
```
</sub>

<h3>07/October/2026</h3>
<sub>

```diff
• Complete migration of AI Agent tool definitions, prompt guidance, and chat log parsing structures to English for global standardization
• Implement robust multi-key API rotation, classification of Gemini failures (transient, auth, rate limit/quota, fatal), and automatic retry backoffs with dynamic sleep delays
• Add new modular tools: 'convert_file' (supporting LibreOffice, ffmpeg, and Pandoc conversions), 'create_zip'/'extract_zip' (with recursive directory skipping and temporary storage management), and 'html_design'/'html_preview' (enabling live interactive web sandbox rendering directly in chat)
• Enhance in-memory message store with 'loadAlbum' functionality and retain parent-sibling 'messageContextInfo' associations during message ingest
• Refactor Code-to-Message (CRM) utility to automatically detect and reconstruct message albums via 'loadAlbum' and extract base64 data URIs from message strings
• Add support for custom sticker styling (splitting names and authors with '|') in the sticker creation command
• Optimize system shutdown routines to cleanly persist message store files on signal execution
• Introduce AI-only output marking mechanism (`AI_ONLY_MARKER`) in MCP to reliably strip raw metadata and format internal plugin executions cleanly for users
• Refactor plugin execution responses to wrap raw command outputs within specific parsing boundaries (`PLUGIN_OUT_START` and `PLUGIN_OUT_END`)

________________________

+ Add "lib/package/ai/tools/convert.js"
+ Add "lib/package/ai/tools/html.js"
* Edit "lib/main.js"
* Edit "lib/package/ai/chatlog.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/database.js"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/ai/tools/group.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/package/ai/tools/memory.js"
* Edit "lib/package/ai/tools/messaging.js"
* Edit "lib/package/ai/tools/plugin.js"
* Edit "lib/package/ai/tools/readchat.js"
* Edit "lib/package/ai/tools/reminder.js"
* Edit "lib/package/ai/tools/system.js"
* Edit "lib/package/ai/tools/web.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/owner/backup.js"
* Edit "plugins/sticker/sticker.js"
* Edit "plugins/tools/crm.js"
```
</sub>
