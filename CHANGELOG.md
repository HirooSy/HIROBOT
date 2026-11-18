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
* Edit "lib/package/voip/relay/relay-ack.js"
* Edit "lib/package/voip/relay/sctp/association.js"
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

<h3>06/November/2026</h3>
<sub>

```diff
• Add text_to_speech AI tool for converting text to spoken audio via Gemini TTS and sending as voice notes
• Implement Gemini TTS helper geminiSpeech in MCP package with voice settings, style options, and API key cooldowns
• Support TTS fallback across multiple Gemini models and update speech generation API handling in MCP package
• Refactor hot-reload module to dynamically reload config.js changes without requiring a full process restart
• Refactor reload watcher helper functions, ignore temporary swap files, and schedule process restarts
• Add global.settings.ai.voice configuration option in config.js for default text-to-speech voice settings
• Update AI message handler to alternate message quoting behavior when replying
• Update AI_KEYS configuration documentation in .env.example and README.md for comma-separated API keys
• Update README.md documentation with Gemini Guest vs API key capability matrix

________________________

* Edit ".env.example"
* Edit "README.md"
* Edit "lib/config.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/tools/media.js"
* Edit "lib/utils/reload.js"
* Edit "plugins/ai/ai.js"
```
</sub>

<h3>05/November/2026</h3>
<sub>

```diff
• Restrict channel upchannel command execution strictly to bot owners with global.dfail authorization
• Add Discord profile connections and snapshot data caching upon Discord OAuth login
• Improve large API response handling in fetch tool by sending as document attachment
• Refactor CRM helper functions and base64/data URI string formatting logic
• Improve conn.getName() contact name resolution by merging contact data from LID and JID mappings

________________________

+ Add "lib/scrapers/src/igstalk.js"
+ Add "lib/scrapers/src/ocr.js"
+ Add "lib/scrapers/src/roblox.js"
+ Add "plugins/internet/discordstalk.js"
+ Add "plugins/internet/igstalk.js"
+ Add "plugins/internet/robloxstalk.js"
+ Add "plugins/tools/ocr.js"
* Edit "lib/package/website/server.js"
* Edit "plugins/main/channel.js"
* Edit "plugins/tools/crm.js"
* Edit "plugins/tools/fetch.js"
* Edit "lib/utils/simple.js"
```
</sub>
