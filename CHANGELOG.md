<h3>20/September/2026</h3>
<sub>

```diff
• Replace 'ws' package with a native, RFC 6455-compliant WebSocket server implementation for improved stability and reduced dependency overhead
• Refactor website server endpoints to support native WebSockets
• Update web dashboard HTML views and upload scrapers
• General refactoring and cleanup of core utilities and VoIP package
• Cleanup legacy and unused modules

________________________

* Edit "lib/main.js"
- Delete "lib/package/voip/relay/WaSctpRelay.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/upload.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/subbot/connect.js"
- Delete "plugins/tools/bypass.js"
* Edit "plugins/tools/resize.js"
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
