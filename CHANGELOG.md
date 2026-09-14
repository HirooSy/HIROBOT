<h3>14/September/2026</h3>
<sub>

```diff
• Major refactoring of VoIP architecture, migrating from worker-based signaling to a streamlined, module-oriented implementation
• Complete overhaul of media engines (audio, video, signaling, relay) for better synchronization and performance
• Cleanup of legacy and deprecated code modules across the VoIP package
• General optimizations in main handler and connection utilities
• Update of owner call plugin functionality

________________________

* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/voip/WaVoipCoordinator.js"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/crypto/rtcp.js"
* Edit "lib/package/voip/crypto/ssrc.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/package/voip/media/audio-codec.js"
* Edit "lib/package/voip/media/h264.js"
* Edit "lib/package/voip/media/rtcp.js"
* Edit "lib/package/voip/media/rtp.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/WaSctpRelay.js"
* Edit "lib/package/voip/relay/datachannel/pre-negotiated.js"
* Edit "lib/package/voip/relay/dtls/aead.js"
* Edit "lib/package/voip/relay/dtls/cert-builder.js"
* Edit "lib/package/voip/relay/dtls/der.js"
* Edit "lib/package/voip/relay/dtls/ecdhe.js"
* Edit "lib/package/voip/relay/dtls/handshake-framing.js"
* Edit "lib/package/voip/relay/dtls/handshake-messages.js"
* Edit "lib/package/voip/relay/dtls/handshake.js"
* Edit "lib/package/voip/relay/dtls/prf.js"
* Edit "lib/package/voip/relay/dtls/record.js"
* Edit "lib/package/voip/relay/sctp/association.js"
* Edit "lib/package/voip/relay/sctp/crc32c.js"
* Edit "lib/package/voip/relay/sctp/wire.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/shim/core.js"
* Edit "lib/package/voip/signaling/signaling.js"
* Edit "lib/package/voip/types.js"
- Delete "lib/package/voip/worker.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/owner/call.js"
+ Add "lib/package/voip/voipClient.js"
```
</sub>

<h3>13/September/2026</h3>
<sub>

```diff
• Proactively force reconnection on internal Baileys socket errors to reduce watchdog-triggered restarts
• Implement row-level locking for the SQLite signal key store to prevent race conditions during concurrent key access
• Add new AI utility (notrack), manga downloader (shinigami), and image tools (bypass, iloveimg, removebg, wink)
• Fix auto save database when sigterm / sigkill
• Refactor tunnel token/hostname env vars and implement Workers KV-based tunnel URL synchronization for cross-client communication
• Add comprehensive documentation in README.md detailing various website exposure scenarios and their required environment configurations
• Update .env.example with the new Cloudflare KV and Tunnel configuration variables

________________________

* Edit "lib/main.js"
* Edit "lib/utils/connection.js"
+ Add "plugins/ai/notrack.js"
+ Add "plugins/dl/shinigami.js"
+ Add "plugins/tools/bypass.js"
+ Add "plugins/tools/iloveimg.js"
+ Add "plugins/tools/removebg.js"
+ Add "plugins/tools/wink.js"
* Edit "lib/utils/database.js"
* Edit "README.md"
* Edit ".env.example"
```
</sub>

<h3>12/September/2026</h3>
<sub>

```diff
• Implement product sending feature via conn.sendProduct in lib/utils/simple.js
• Add product sending documentation in README.md
• Major refactor of VoIP modules (WaCallMediaSession, h264, simple.js) for improved signaling, audio-video synchronization, and performance
• Significant cleanup of handler.js by removing legacy and unused utility functions

________________________

* Edit ".env.example"
* Edit "README.md"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/package/voip/media/h264.js"
* Edit "lib/package/voip/signaling/bridge.js"
* Edit "lib/package/voip/signaling/signaling.js"
* Edit "lib/package/voip/worker.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/simple.js"
```
</sub>

<h3>11/September/2026</h3>
<sub>

```diff
• Implement WebSocket broadcasting support in web dashboard server to enable cross-client communication
• Enhance e621 scraper stability and refine data parsing in scraper and plugin modules
• Improve connection utility resilience and handler management
• Minor stability improvements and refactoring for Pinterest downloader plugin
• Replace MLowCodec with AudioCodec for streamlined VoIP audio handling
• Clean up redundant dependencies by removing libmlow-wasm
• Add a URL shortener utility plugin powered by TinyURL's create API

________________________

+ Add "plugins/tools/tinyurl.js"
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
