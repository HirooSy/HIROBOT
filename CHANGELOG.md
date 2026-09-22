<h3>22/September/2026</h3>
<sub>

```diff
• Massive refactoring of canvas utility for optimized rendering and performance
• Database utility enhancements and optimization for better reliability
• Refactor brat scraper for improved stability and functional consistency
• Dependency updates in package.json and configuration sync
• Cleanup of legacy plugins and minor maintenance across core utilities
• Implement isolated extra connection update listener and diagnostic logging for Baileys socket disconnects
• Add periodic diagnostic timer to WaCallMediaSession reporting real-time VoIP performance metrics (SCTP queue, Opus codec, and packet loss stats)
• Enable RFC 7675-style ICE consent refreshes on WaManualRelay for open connections to prevent random mid-call drops, and defer DTLS initialization until ICE binding is verified
• Route WhatsApp web-call media channels as unordered SCTP chunks and handle immediate delivery on receipt to bypass stream sequencing issues under packet loss
• Improve bot process restart sequence on 'reset' signal by deferring restart until the child process has fully exited
• Update e621 search plugin tags and bump bot version to 1.2.1

________________________

* Edit "lib/utils/canvas.js"
* Edit "lib/utils/database.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/utils/simple.js"
* Edit "lib/utils/converter.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "plugins/owner/setpp.js"
* Edit "plugins/tools/resize.js"
* Edit "package.json"
* Edit ".env.example"
* Edit "README.md"
* Edit "plugins/owner/migratedb.js"
* Edit "lib/main.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/sctp/association.js"
* Edit "lib/start.js"
* Edit "lib/utils/connection.js"
* Edit "plugins/dl/e621.js"
```
</sub>

<h3>20/September/2026</h3>
<sub>

```diff
• Replace 'ws' package with a native, RFC 6455-compliant WebSocket server implementation for improved stability and reduced dependency overhead
• Refactor website server endpoints to support native WebSockets
• Update web dashboard HTML views and upload scrapers
• General refactoring and cleanup of core utilities and VoIP package
• Cleanup legacy and unused modules
• Optimize tunnel setup by replacing Promise-based connection waiting with a global callback mechanism for improved reliability
• Implement robust error handling for tunnel initialization on connection open
• Implement group history context in AI agent to improve conversation understanding, utilizing a new `chatlog` module for message unwrapping and context building
• Add `readchat` tool for browsing group chat history
• Update system instructions to include Group History guidelines

________________________

* Edit "lib/main.js"
* Edit "lib/utils/connection.js"
- Delete "lib/package/voip/relay/WaSctpRelay.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/upload.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/subbot/connect.js"
- Delete "plugins/tools/bypass.js"
* Edit "plugins/tools/resize.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
+ Add "lib/package/ai/chatlog.js"
+ Add "lib/tools/readchat.js"
```
</sub>

<h3>17/September/2026</h3>
<sub>

```diff
• Redesign portfolio hero section in website view for a more immersive and modern UI
• Optimized hero components for responsiveness and performance

________________________

* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
```
</sub>

<h3>16/September/2026</h3>
<sub>

```diff
• Refactor VoIP media session and video engine for better stability and synchronization
• Major refactoring of connection utility to enhance resilience
• Update Telegram sticker plugin and subbot connection logic
• Core maintenance in main and configuration files

________________________

* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/sticker/telegram.js"
* Edit "plugins/subbot/connect.js"
```
</sub>

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
* Edit "lib/package/voip/relay/signaling/signaling.js"
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