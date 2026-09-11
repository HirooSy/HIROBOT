<h3>11/September/2026</h3>
<sub>

```diff
• Implement WebSocket broadcasting support in web dashboard server to enable cross-client communication
• Enhance e621 scraper stability and refine data parsing in scraper and plugin modules
• Improve connection utility resilience and handler management
• Minor stability improvements and refactoring for Pinterest downloader plugin
• Replace MLowCodec with AudioCodec for streamlined VoIP audio handling
• Clean up redundant dependencies by removing libmlow-wasm

________________________

+ Add "lib/package/voip/media/audio-codec.js"
- Delete "lib/package/voip/media/mlow-codec.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/media/h264.js"
* Edit "lib/package/voip/relay/sctp/association.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/e621.js"
* Edit "lib/utils/connection.js"
* Edit "package.json"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/pinterest.js"
```
</sub>

<h3>10/September/2026</h3>
<sub>

```diff
• Add AlightMotion premium activation plugin with magic link support and session-based re-activation capabilities

________________________

+ Add "plugins/tools/alightmotion.js"
```
</sub>

<h3>09/September/2026</h3>
<sub>

```diff
• Simplify interactive location documentation in README.md
• Improve CDN connection resilience in website server by adding a retry mechanism with short timeout for flaky upstream requests
• Enable CORS for auth-related API endpoints in web dashboard to support sandboxed WhatsApp HTML
• Refactor and optimize core utility functions in simple.js
• Perform minor connection update in subbot connect plugin
• Add mute and unmute command plugin for group chat with custom message deletion implementation

________________________

+ Add "plugins/group/mute.js"
* Edit "README.md"
* Edit "lib/package/website/server.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/subbot/connect.js"
```
</sub>

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
