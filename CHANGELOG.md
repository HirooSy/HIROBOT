<h3>20/August/2026</h3>
<sub>

```diff
• Add pure JS pdf2img converter function utilizing pureimage for extracting embedded scan-style page images without external system binaries
• Fix didYouMean suggestions by matching customPrefix plugins to prevent command suggestions from interfering with regex-triggered commands
• Refactor quoted message download guard in simple serializer to safely prevent downloads on non-media messages
• Fix hot reload mechanism by correctly excluding unnecessary directories (node_modules, .git, etc.) from file watch list and fixing library directory path resolution
• Replace heavy 'awesome-phonenumber' dependency with a lightweight native country code formatting implementation
• Migrate image processing logic to Sharp for improved performance and reliability
• Improve connection reload socket handling for cleaner closure
• Add image buffer helper and minimal WebP chunk parsing in simple utilities
• Optimize EXIF handling and refactor resize logic
• Cleanup package dependencies and refactor owner set profile picture plugin
• Update Pinterest, X, and downloader plugins (e621, fb, ig, pornhub) for improved robustness
• Minor refactor to utility simple module and cleanup package dependencies
• Refactor lazy module loader in database.js to include robust npm install retries and dynamic project root detection for cleaner dependency management
• Improve lib/start.js error logging and ensure config.js is imported after confirming environment dependencies are met
• Add 'migratedb' owner plugin to enable data migration between local SQLite and cloud (MongoDB/MySQL) databases
• Implement PDF image extraction and PNG conversion in utilities using pureimage
• Improve didYouMean command suggestion logic with custom prefix support
• Enhance quoted message download safety and cleanup redundant download property deletions
• Fix SQL local database autosave mechanism
• Add Mistral AI fallback when AI_KEYS are missing
• Fix autoheal mechanism

________________________

* Edit "lib/utils/converter.js"
* Edit "lib/utils/handler.js"
* Edit "lib/main.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/utils/connection.js"
* Edit "plugins/owner/setpp.js"
* Edit "plugins/tools/exif.js"
* Edit "plugins/tools/resize.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/x.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/fb.js"
* Edit "plugins/dl/ig.js"
* Edit "plugins/dl/pornhub.js"
* Edit "lib/start.js"
* Edit "lib/utils/database.js"
+ Add "plugins/owner/migratedb.js"
* Edit "lib/package/ai/mcp.js"
* Edit "plugins/ai/ai.js"
+ Add "lib/package/ai/prompt.txt"
```
</sub>

<h3>19/August/2026</h3>
<sub>

```diff
• Massive architectural refactor: migrated legacy lib modules into structured directories (lib/package, lib/scrapers) for better maintainability and modularity
• Removed redundant/legacy lib files and VoIP modules in favor of new structured system
• Updated plugins and handlers to align with new project structure
• Clean up legacy single-file and multi-file credentials migration logic from connection utility, simplifying SQLite-based auth state initialization
• Migrate VoIP authentication and device-pairing status checks to utilize SQLite credentials structure natively instead of checking legacy JSON file existence
• Adjust default VoIP worker authentication database extension path from '.db' to '.session'

________________________

* Edit ".env.example"
* Edit "README.md"
- Delete "lib/ai/mcp.js"
- Delete "lib/ai/tools/database.js"
- Delete "lib/ai/tools/files.js"
- Delete "lib/ai/tools/group.js"
- Delete "lib/ai/tools/media.js"
- Delete "lib/ai/tools/memory.js"
- Delete "lib/ai/tools/messaging.js"
- Delete "lib/ai/tools/plugin.js"
- Delete "lib/ai/tools/reminder.js"
- Delete "lib/ai/tools/system.js"
- Delete "lib/ai/tools/web.js"
- Delete "lib/color.js"
* Edit "lib/config.js"
- Delete "lib/connection.js"
- Delete "lib/converter.js"
- Delete "lib/database.js"
- Delete "lib/handler.js"
- Delete "lib/helper.js"
* Edit "lib/main.js"
- Delete "lib/plugins.js"
- Delete "lib/scraper/ai-image.js"
- Delete "lib/scraper/animein.js"
- Delete "lib/scraper/brat.js"
- Delete "lib/scraper/e621.js"
- Delete "lib/scraper/ezgif.js"
- Delete "lib/scraper/facebook.js"
- Delete "lib/scraper/ig.js"
- Delete "lib/scraper/nano.js"
- Delete "lib/scraper/pinterest.js"
- Delete "lib/scraper/tiktok.js"
- Delete "lib/scraper/upload.js"
- Delete "lib/scraper/x.js"
- Delete "lib/scraper/ytdl.js"
- Delete "lib/scraper/ytsearch.js"
- Delete "lib/scraper/ytsearch.js"
- Delete "lib/server.js"
- Delete "lib/simple.js"
* Edit "lib/start.js"
- Delete "lib/views/index.html"
- Delete "lib/views/profile.html"
- Delete "lib/voip/index.js"
- Delete "lib/voip/loader.js"
- Delete "lib/voip/modules/audio-feeder.js"
- Delete "lib/voip/modules/relay-transport.js"
- Delete "lib/voip/modules/signaling.js"
- Delete "lib/voip/modules/types.js"
- Delete "lib/voip/modules/video-feeder.js"
- Delete "lib/voip/modules/whatsapp.wasm"
- Delete "lib/voip/modules/worker-bootstrap.js"
- Delete "lib/voip/modules/worker-modules.js"
- Delete "lib/voip/modules/worker.js"
- Delete "lib/voip/voip.js"
* Edit "lib/package/voip/modules/worker.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/simple.js"
```
</sub>

<h3>17/August/2026</h3>
<sub>

```diff
• Implement poll vote decryption by wiring Baileys decryptPollVote to handle encrypted vote messages, mapping option hashes to readable names
• Comprehensive updates to message management utilities supporting the new poll update integration
• Refactor VoIP core index exports for improved module structure
• Optimization to video-feeder and WASM-engine modules for better performance/stability
• Refactor handler and main logic to streamline core operations
• Optimize database handling for improved performance and data integrity
• Enhance connection persistence and connection recovery mechanics
• Refine VoIP modules for better call stability and worker management
• Update owner call and subbot plugins for expanded connectivity features
• Implement log muting for noise/unnecessary console outputs in main handler
• Refactor VoIP initialization logic in index.js to streamline call connection
• Refine signaling and audio/video feeder modules for improved sync stability
• Refactor database default objects into a single nested structure for better maintainability
• Add helper function for splitting default values and keys to streamline structure management
• Cleanup redundant exports in database and unused functions in handler
• Refactor database handling by removing lodash dependency and implementing a custom chain helper wrapper for native Javascript operations

________________________

* Edit "lib/connection.js"
* Edit "lib/database.js"
* Edit "lib/handler.js"
* Edit "lib/main.js"
* Edit "lib/simple.js"
* Edit "lib/voip/index.js"
* Edit "lib/voip/modules/audio-feeder.js"
* Edit "lib/voip/modules/signaling.js"
* Edit "lib/voip/modules/video-feeder.js"
* Edit "lib/voip/modules/wasm-engine.js"
* Edit "lib/voip/modules/worker.js"
* Edit "package.json"
* Edit "plugins/owner/call.js"
* Edit "plugins/subbot/connect.js"
```
</sub>

<h3>16/August/2026</h3>
<sub>

```diff
• Simplify contextInfo retrieval and clean up internal helper comments
• Refine AI instructions for gitpush workflow, clarifying that code diffs shouldn't be included in CHANGELOG.md
• Change auto-install dependency from 'caller' to 'wrtc' utilizing the same @roamhq/wrtc package under clean naming
• Adjust GitHub plugin risk assessment to 'low' allowing safe AI-driven repository synchronization
• Refactor AudioFeeder to pre-decode audio source files completely into memory before playback, resolving real-time ffmpeg streaming bottlenecks
• Introduce fakemsg plugin to craft or replace messages in group chats using protocolMessage edit frames
• Fix video call delay by synchronizing audio start with video-feeder ready state to prevent audio out-of-sync

________________________

+ Add "CHANGELOG.md"
+ Add "plugins/group/fakemsg.js"
+ Add "plugins/owner/deletemsg.js"
* Edit "lib/ai/mcp.js"
* Edit "lib/voip/voip.js"
* Edit "plugins/owner/github.js"
* Edit "lib/voip/modules/audio-feeder.js"
* Edit "lib/voip/index.js"
* Edit "lib/voip/modules/video-feeder.js"
* Edit "lib/voip/modules/wasm-engine.js"
* Edit "package.json"
* Edit "README.md"
* Edit "LICENSE"
```
</sub>
