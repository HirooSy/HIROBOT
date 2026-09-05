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
• Optimize project root path discovery in loadVoip using an iterative parent-directory node_modules check

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
