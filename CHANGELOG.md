<h3>08/September/2026</h3>
<sub>

```diff
• Add Dino Runner HTML mini-game plugin under a new 'game' category that rewards players with virtual gems based on score milestones
• Update menu category definitions to support and display the new 'game' tag
• Remove image resizing in Pinterest search results to allow previewing in full resolution
• Refactor e621 plugin for enhanced scraper stability and data parsing
• Update e621 scraper module and minor adjustments to owner call plugin
• Refactor interactive HTML action handling in the web dashboard server to replace per-feature string dispatch with functional token-based closures

________________________

+ Add "plugins/game/dino.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/e621.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/owner/call.js"
```
</sub>

<h3>07/September/2026</h3>
<sub>

```diff
• Update pinterest downloader and server modules to implement and test WebSocket HTML capabilities
• Redesign README.md features layout, update visual structure representation, and document supported AI models usage
• Refactor web dashboard to extract performHtmlAction and implement explicit CORS headers for /api/aiRich/action to support sandboxed WhatsApp webview calls
• Refactor AIRich addHtml builder method to support dynamic server URLs and customizable trusted sources options
• Optimize Pinterest image downloader to fetch and resize images in parallel, and pass secure dashboard domains as trusted HTML sources

________________________

* Edit "README.md"
* Edit "lib/package/website/server.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/dl/pinterest.js"
* Edit "CHANGELOG.md"
```
</sub>

<h3>06/September/2026</h3>
<sub>

```diff
• Implement .addHtml() method in AIRich builder (replacing the previous .html() method) to support single HTML payloads and tabbed multi-screen embedded responses
• Add .addProcess() method in AIRich builder to display animated primitive progress statuses (GenAIBotProgressStatusPrimitive)
• Add comprehensive documentation and examples for both .addHtml() and .addProcess() to README.md
• Strip default text caption from facebook downloader output to deliver clean media results
• Redesign pinterest downloader: implement asynchronous downscaling and JPEG recompression of images using Sharp under a 2MB total base64 limit to prevent Baileys websocket write EPIPE connection drops from oversized payloads
• Embed an interactive swipeable HTML photo gallery within an AIRich container via .addHtml() for multi-image Pinterest searches

________________________

* Edit "README.md"
* Edit "lib/utils/simple.js"
* Edit "plugins/dl/fb.js"
* Edit "plugins/dl/pinterest.js"
* Edit "CHANGELOG.md"
```
</sub>

<h3>05/September/2026</h3>
<sub>

```diff
• Massive expansion of VoIP subsystem: implemented custom RTCP handling, advanced WaCallMediaSession management, and foundational support for data channels, DTLS, and SCTP
• Implement WaManualRelay for better control over media flow
• Integrate core handlers and utility functions with the new VoIP relay infrastructure
• Clean up e621 scraper and refine menu plugin options
• Switch YouTube downloader scraper from Epsilon API to SaveTube API for improved stability and reliability

________________________

+ Add "lib/package/voip/crypto/rtcp.js"
+ Add "lib/package/voip/media/rtcp.js"
+ Add "lib/package/voip/relay/WaManualRelay.js"
+ Add "lib/package/voip/relay/datachannel/"
+ Add "lib/package/voip/relay/dtls/"
+ Add "lib/package/voip/relay/sctp/"
* Edit "README.md"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/crypto/ssrc.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/shim/core.js"
* Edit "lib/package/voip/types.js"
* Edit "lib/package/voip/worker.js"
* Edit "lib/scrapers/src/e621.js"
* Edit "lib/scrapers/src/ytdl.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/main/menu.js"
* Edit "CHANGELOG.md"
```
</sub>

<h3>29/August/2026</h3>
<sub>

```diff
• Massive refactor of VoIP subsystem: migrated from legacy modules (wasm, feeders, signaling) to a modern, structured modular architecture in lib/package/voip/
• Update scrapers for Brat and X modules
• Enhance utility modules including connection handler, converter, and simple message serialization
• Update various plugins to ensure compatibility with new architecture
• Add new utilities for canvas manipulation and hot-reload functionality
• Maintain project dependencies and documentation alignment

________________________

* Edit ".env.example"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/voip/*.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/converter.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/dl/x.js"
* Edit "plugins/group/add.js"
* Edit "plugins/main/creator.js"
* Edit "plugins/owner/backup.js"
* Edit "plugins/owner/call.js"
* Edit "plugins/subbot/connect.js"
+ Add "lib/utils/canvas.js"
+ Add "lib/utils/reload.js"
```
</sub>

<h3>22/August/2026</h3>
<sub>

```diff
• Replace 'pureimage' with direct font parsing and Sharp in lib/scrapers/src/brat.js for improved performance
• Remove unused dependency 'pureimage' from package.json
• Clean up redundant diagnostic logs and unused unknownCallEvent event listeners from VOIP modules
• Improve safety of worker process communication by catching IPC channel closure errors before calling process.send
• Optimize project root path estimation in loadVoip using an iterative parent-directory node_modules check

________________________

* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/modules/signaling.js"
* Edit "lib/package/voip/modules/worker.js"
* Edit "lib/package/voip/voip.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/owner/call.js"
```
</sub>