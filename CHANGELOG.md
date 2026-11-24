<h3>24/November/2026</h3>
<sub>

```diff
• Migrate configuration system from `.env` and `lib/config.js` to a unified `config.json` file with `config.example.json` template
• Refactor configuration parsing and startup logic in `start.js` and `helper.js`
• Update AI prompt rules, MCP tool adapters, web server, and bot utilities to read settings from `global.config`
• Refactor file reload watcher, cluster workers, and handler utilities
• Remove obsolete `.env.example`, `lib/config.js`, and `viewonce.js` plugin

________________________

+ Add "config.example.json"
+ Add "config.json"
- Delete ".env.example"
- Delete "lib/config.js"
- Delete "plugins/tools/viewonce.js"
* Edit "README.md"
* Edit "lib/main.js"
* Edit "lib/package/ai/chatlog.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/ai/tools/memory.js"
* Edit "lib/package/ai/tools/messaging.js"
* Edit "lib/package/ai/tools/system.js"
* Edit "lib/package/website/server.js"
* Edit "lib/scrapers/src/brat.js"
* Edit "lib/scrapers/src/discordstalk.js"
* Edit "lib/start.js"
* Edit "lib/utils/botsManager.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/ai/ai.js"
* Edit "plugins/group/add.js"
* Edit "plugins/main/invite.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/main/owner.js"
* Edit "plugins/main/profile.js"
* Edit "plugins/owner/github.js"
* Edit "plugins/owner/migratedb.js"
* Edit "plugins/owner/restart.js"
* Edit "plugins/owner/sw.js"
* Edit "plugins/sticker/setwm.js"
* Edit "plugins/sticker/sticker.js"
* Edit "plugins/sticker/telegram.js"
```
</sub>

<h3>19/November/2026</h3>
<sub>

```diff
• Disable `autoDowngrade` in `VoipCall` constructor
• Add worker communication for CLI questions in `start.js`
• Refactor `question` promise in `connection.js` to support cross-process worker communication
• Refactor `question` promise to include `getPairingPhone` with caching and timeout support
• Switch to `rmWithRetry` for auth file cleanup
• Refactor TV internet plugin and enhance ping command output
• Update AI default personality to professional/formal tone, removing anime/silly style
• Add Windows-specific support for TMP directory and process spawning in cloudflared
• Sanitize outgoing chat content in AI adapter

________________________

- Delete "plugins/group/grouplist.js"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/package/ai/tools/system.js"
* Edit "lib/package/canvas.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/x.js"
* Edit "lib/start.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/simple.js"
* Edit "plugins/canvas/quotes.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/fb.js"
* Edit "plugins/dl/ig.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/internet/tv.js"
* Edit "plugins/main/ping.js"
* Edit "plugins/owner/backup.js"
* Edit "plugins/owner/files.js"
* Edit "plugins/owner/grep.js"
```
</sub>

<h3>18/November/2026</h3>
<sub>

```diff
• Refactor VoIP call engine, media sessions, and signaling handlers for improved reliability, memory efficiency, and group call support
• Update play and owner call plugins to integrate refined VoIP coordination and improved media handling
• Minor documentation improvements and dependency configuration adjustments

________________________

* Edit "lib/package/voip/WaVoipCoordinator.js"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/call/call-state.js"
* Edit "lib/package/voip/crypto/rtcp.js"
* Edit "lib/package/voip/crypto/srtp.js"
* Edit "lib/package/voip/crypto/ssrc.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/audio-codec.js"
* Edit "lib/package/voip/media/mlow-codec.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/sctp/association.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/signaling/bridge.js"
* Edit "lib/package/voip/signaling/signaling.js"
* Edit "lib/package/voip/types.js"
* Edit "lib/package/voip/voip-deps.js"
* Edit "lib/package/voip/voipClient.js"
* Edit "package.json"
* Edit "plugins/main/play.js"
* Edit "plugins/owner/call.js"
* Edit "README.md"
```
</sub>

<h3>16/November/2026</h3>
<sub>

```diff
• Add VoIP group calls: ad-hoc, group-bound and invited calls with roster tracking, shared key epochs, per-participant media receive and audio mixing
• Add call links: create a room, get the link of any call (1:1, group or room) with await voip.getLink(callId), preview a link and join through a link
• Add waiting room controls: approval toggle, admit, deny and heartbeat
• Add add/ring participant, group raise hand and group call commands to the owner call plugin
• Add group relay allocation with sender/receiver subscriptions, HBH-FEC descriptors and forwarded packet unwrapping
• Add rekeyable SRTP/SRTCP contexts and participant ID formatting for group media keys
• Add call link to play: .play rings the requester into a link call (1:1 fallback), the link is shown in the status as an invite after the requester accepts, only people inside the call see and use the music controls (shown again on every join) and the call ends when nobody is left
• Fix relay reconnect loop that kept opening UDP sockets and timers after a call had ended
• Fix libopus WASM memory staying allocated forever, it is now released after the codecs have been idle
• Reduce call memory: decode-only and encode-only codecs, Int16 audio source buffer and single buffer ffmpeg decoding

________________________

* Edit "lib/package/voip/WaVoipCoordinator.js"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/call/call-state.js"
* Edit "lib/package/voip/crypto/rtcp.js"
* Edit "lib/package/voip/crypto/srtp.js"
* Edit "lib/package/voip/crypto/ssrc.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/audio-codec.js"
* Edit "lib/package/voip/media/mlow-codec.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/signaling/bridge.js"
* Edit "lib/package/voip/signaling/signaling.js"
* Edit "lib/package/voip/types.js"
* Edit "lib/package/voip/voip-deps.js"
* Edit "lib/package/voip/voipClient.js"
* Edit "plugins/main/play.js"
* Edit "plugins/owner/call.js"
* Edit "README.md"
```
</sub>

<h3>15/November/2026</h3>
<sub>

```diff
• Add isGroupTarget helper in simple.js to restrict hidden message delivery handling strictly to group chats
• Simplify native flow node construction by removing redundant biz_bot tag attachment on non-group targets

________________________

* Edit "lib/utils/simple.js"
```
</sub>

<h3>14/November/2026</h3>
<sub>

```diff
• Add SPR message tool plugin for targeted hidden message delivery
• Add SoundCloud, Threads and TV stream channel scraper modules and plugins
• Refactor VoIP call engine, media sessions, and relay handlers for enhanced WebRTC call handling
• Update Discord module payload handling, permissions, text, and voice options
• Refactor handler, connection, database, and simple core utilities
• Update web server dashboard views and API route handling
• Update Spotify and Telegram scraper modules along with various group and downloader plugins
• Fix sequence gap calculation logic in VoIP media session packet receiver and remove unused footer constant in WhatsApp music controls

________________________

+ Add "lib/scrapers/src/soundcloud.js"
+ Add "lib/scrapers/src/threads.js"
+ Add "lib/scrapers/src/tv.js"
+ Add "plugins/dl/soundcloud.js"
+ Add "plugins/dl/threads.js"
+ Add "plugins/internet/tv.js"
+ Add "plugins/tools/spr.js"
* Edit "lib/config.js"
* Edit "lib/main.js"
* Edit "lib/package/discord/opus.js"
* Edit "lib/package/discord/payload.js"
* Edit "lib/package/discord/permissions.js"
* Edit "lib/package/discord/text.js"
* Edit "lib/package/discord/voice.js"
* Edit "lib/package/voip/app-data/WaAppDataStream.js"
* Edit "lib/package/voip/call/WaCallManager.js"
* Edit "lib/package/voip/call/WaCallMediaSession.js"
* Edit "lib/package/voip/index.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/package/voip/media/mlow-codec.js"
* Edit "lib/package/voip/relay/WaManualRelay.js"
* Edit "lib/package/voip/relay/dtls/handshake.js"
* Edit "lib/package/voip/relay/stun.js"
* Edit "lib/package/voip/types.js"
* Edit "lib/package/voip/voipClient.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/connect.html"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/spotify.js"
* Edit "lib/scrapers/src/telegram.js"
* Edit "lib/utils/botsManager.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/database.js"
* Edit "lib/utils/handler.js"
* Edit "lib/utils/plugins.js"
* Edit "lib/utils/print.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/dl/apkpure.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/sfile.js"
* Edit "plugins/group/ban.js"
* Edit "plugins/group/kick.js"
* Edit "plugins/group/nickname.js"
* Edit "plugins/group/role.js"
* Edit "plugins/group/slowmode.js"
* Edit "plugins/main/play.js"
* Edit "plugins/main/profile.js"
* Edit "plugins/owner/call.js"
* Edit "plugins/sticker/telegram.js"
```
</sub>

<h3>07/November/2026</h3>
<sub>

```diff
• Refactor global.settings.icon into global.settings.website object with icon, thumbnail, and description properties
• Add dynamic OpenGraph and Twitter meta tag injection for website server responses
• Implement WebSocket connection authorization callback handling in WebSocketServer
• Increase random upload filename generation length to 20 bytes for enhanced uniqueness
• Add strict 64-character hex format validation for authorization bearer tokens
• Inline page view scripts back into templates and implement dynamic script externalization in server with SHA-1 hashing and immutable `/_p/:hash.js` endpoint caching
• Update handler order message thumbnail references to global.settings.website.icon
• Extract inline scrapers across AI, downloader, internet, sticker, and tool plugins into dedicated modules in `lib/scrapers/src/`
• Add standalone plugins and scraper modules for DeepAI, DeepSeek, Sfile downloader, Lyrics search, and InboxKitten
• Update README branding images, header layout, and Baileys-lite badge

________________________

+ Add "lib/scrapers/src/aicheck.js"
+ Add "lib/scrapers/src/deepai.js"
+ Add "lib/scrapers/src/deepseek.js"
+ Add "lib/scrapers/src/discordstalk.js"
+ Add "lib/scrapers/src/drive.js"
+ Add "lib/scrapers/src/gpt.js"
+ Add "lib/scrapers/src/hd.js"
+ Add "lib/scrapers/src/iloveimg.js"
+ Add "lib/scrapers/src/inboxkitten.js"
+ Add "lib/scrapers/src/lyrics.js"
+ Add "lib/scrapers/src/mediafire.js"
+ Add "lib/scrapers/src/notrack.js"
+ Add "lib/scrapers/src/pollination.js"
+ Add "lib/scrapers/src/pornhub.js"
+ Add "lib/scrapers/src/reddit.js"
+ Add "lib/scrapers/src/removebg.js"
+ Add "lib/scrapers/src/sfile.js"
+ Add "lib/scrapers/src/shinigami.js"
+ Add "lib/scrapers/src/speedtest.js"
+ Add "lib/scrapers/src/spotify.js"
+ Add "lib/scrapers/src/ssweb.js"
+ Add "lib/scrapers/src/telegram.js"
+ Add "lib/scrapers/src/tinyurl.js"
+ Add "lib/scrapers/src/wink.js"
+ Add "plugins/ai/deepai.js"
+ Add "plugins/ai/deepseek.js"
+ Add "plugins/dl/sfile.js"
+ Add "plugins/internet/lyrics.js"
+ Add "plugins/tools/inboxkitten.js"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/website/server.js"
* Edit "lib/package/website/views/connect.html"
* Edit "lib/package/website/views/index.html"
* Edit "lib/package/website/views/profile.html"
* Edit "lib/scrapers/src/e621.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/utils/handler.js"
* Edit "plugins/ai/aicheck.js"
* Edit "plugins/ai/gpt.js"
* Edit "plugins/ai/notrack.js"
* Edit "plugins/ai/pollination.js"
* Edit "plugins/dl/drive.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/mediafire.js"
* Edit "plugins/dl/pinterest.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/dl/reddit.js"
* Edit "plugins/dl/shinigami.js"
* Edit "plugins/dl/spotify.js"
* Edit "plugins/internet/discordstalk.js"
* Edit "plugins/main/speedtest.js"
* Edit "plugins/sticker/telegram.js"
* Edit "plugins/tools/alightmotion.js"
* Edit "plugins/tools/hd.js"
* Edit "plugins/tools/iloveimg.js"
* Edit "plugins/tools/removebg.js"
* Edit "plugins/tools/ssweb.js"
* Edit "plugins/tools/tinyurl.js"
* Edit "plugins/tools/wink.js"
```
</sub>
