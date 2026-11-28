<h3>28/November/2026</h3>
<sub>

```diff
• Refined Baileys internal error detection in lib/main.js by checking stack frames and fatal signatures while lowering the ignored error window and threshold.
• Updated @hiroosy/baileys-lite dependency to ^0.4.6 in package.json.
• Added error handling around message reactions and readMessages calls in lib/utils/handler.js and plugins/main/ping.js to prevent unhandled rejections.
• Added a comment in config.example.js documenting the browser setting for fixing viewonce issues.
• Upgrade the default AI model to gemini-4-hydrogen in lib/package/ai/mcp.js
• Add mandatory project-aware coding and structural rules to prompt.txt
• Implement project import validation helper to detect invalid paths in lib/package/ai/tools/files.js
• Optimize command fuzzy matching with Damerau-Levenshtein in lib/utils/handler.js
• Update AI help menu in plugins/ai/ai.js to reflect the new default model

________________________

* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/prompt.txt"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/ai/tools/web.js"
* Edit "lib/utils/handler.js"
* Edit "plugins/ai/ai.js"
* Edit "plugins/main/menu.js"
* Edit "plugins/tools/resize.js"
* Edit "config.example.js"
* Edit "lib/main.js"
* Edit "package.json"
* Edit "plugins/main/ping.js"
```
</sub>

<h3>27/November/2026</h3>
<sub>

```diff
• Update the Node.js engine requirement in package.json to allow compatibility with all Node.js 18.x versions.
• Broaden the project runtime version support to improve compatibility across different environments.
• Expand the ffmpeg native bridge to support image conversion and direct argument execution.
• Introduce new demuxers for Matroska, TS, and image formats to improve container support.
• Add advanced ffmpeg pipeline options like video filters, frame control, and stream mapping.
• Integrate native ffmpeg argument execution into the Pinterest and X scrapers to bypass external dependencies.
• Implement internal support for image processing and network-based inputs within the ffmpeg package.

________________________

* Edit "lib/package/ffmpeg/bridge.js"
* Edit "lib/package/ffmpeg/index.d.ts"
* Edit "lib/package/ffmpeg/index.js"
* Edit "lib/package/ffmpeg/lib/cli.js"
* Edit "lib/package/ffmpeg/lib/demux/index.js"
* Edit "lib/package/ffmpeg/lib/pipeline.js"
* Edit "lib/scrapers/src/pinterest.js"
* Edit "lib/scrapers/src/x.js"
* Edit "plugins/dl/e621.js"
* Edit "plugins/dl/pornhub.js"
* Edit "plugins/main/channel.js"
+ Add "lib/package/ffmpeg/lib/bsf.js"
+ Add "lib/package/ffmpeg/lib/compat.js"
+ Add "lib/package/ffmpeg/lib/demux/image.js"
+ Add "lib/package/ffmpeg/lib/demux/matroska.js"
+ Add "lib/package/ffmpeg/lib/demux/merge.js"
+ Add "lib/package/ffmpeg/lib/demux/ts.js"
+ Add "lib/package/ffmpeg/lib/ffargs.js"
+ Add "lib/package/ffmpeg/lib/filter/video.js"
+ Add "lib/package/ffmpeg/lib/image/bmp.js"
+ Add "lib/package/ffmpeg/lib/image/frame.js"
+ Add "lib/package/ffmpeg/lib/image/gif.js"
+ Add "lib/package/ffmpeg/lib/image/index.js"
+ Add "lib/package/ffmpeg/lib/image/jpeg.js"
+ Add "lib/package/ffmpeg/lib/image/png.js"
+ Add "lib/package/ffmpeg/lib/net.js"
* Edit "package.json"
```
</sub>

<h3>25/November/2026</h3>
<sub>

```diff
• Migrated the configuration system from .jsonc to .js files to improve project settings flexibility.
• Added a custom native FFmpeg implementation to reduce external binary dependencies for media processing.
• Integrated the new native FFmpeg library into AI audio conversion tools and the VoIP media engine to enhance processing efficiency.
• Updated documentation and system references to align with the new configuration and media handling architecture.

________________________

* Edit "README.md"
- Delete "config.example.jsonc"
* Edit "lib/main.js"
* Edit "lib/package/ai/mcp.js"
* Edit "lib/package/ai/tools/convert.js"
* Edit "lib/package/ai/tools/files.js"
* Edit "lib/package/voip/media/WaAudioEngine.js"
* Edit "lib/package/voip/media/WaVideoEngine.js"
* Edit "lib/start.js"
* Edit "lib/utils/botsManager.js"
* Edit "lib/utils/connection.js"
* Edit "lib/utils/helper.js"
* Edit "lib/utils/reload.js"
* Edit "lib/utils/simple.js"
* Edit "package.json"
* Edit "plugins/owner/github.js"
* Edit "plugins/owner/migratedb.js"
+ Add "config.example.js"
+ Add "config.js"
+ Add "lib/package/ffmpeg/LICENSE"
+ Add "lib/package/ffmpeg/bin/ffnode.js"
+ Add "lib/package/ffmpeg/bridge.js"
+ Add "lib/package/ffmpeg/index.d.ts"
+ Add "lib/package/ffmpeg/index.js"
+ Add "lib/package/ffmpeg/lib/bits.js"
+ Add "lib/package/ffmpeg/lib/cli.js"
+ Add "lib/package/ffmpeg/lib/codec/flac.js"
+ Add "lib/package/ffmpeg/lib/codec/index.js"
+ Add "lib/package/ffmpeg/lib/codec/libopus.js"
+ Add "lib/package/ffmpeg/lib/codec/mp3.js"
+ Add "lib/package/ffmpeg/lib/codec/mpa.js"
+ Add "lib/package/ffmpeg/lib/codec/mpa_tables.js"
+ Add "lib/package/ffmpeg/lib/codec/opus.js"
+ Add "lib/package/ffmpeg/lib/codec/pcm.js"
+ Add "lib/package/ffmpeg/lib/crc.js"
+ Add "lib/package/ffmpeg/lib/debug.js"
+ Add "lib/package/ffmpeg/lib/demux/adts.js"
+ Add "lib/package/ffmpeg/lib/demux/flac.js"
+ Add "lib/package/ffmpeg/lib/demux/index.js"
+ Add "lib/package/ffmpeg/lib/demux/mp3.js"
+ Add "lib/package/ffmpeg/lib/demux/mp4.js"
+ Add "lib/package/ffmpeg/lib/demux/ogg.js"
+ Add "lib/package/ffmpeg/lib/demux/wav.js"
+ Add "lib/package/ffmpeg/lib/errors.js"
+ Add "lib/package/ffmpeg/lib/filter/gain.js"
+ Add "lib/package/ffmpeg/lib/filter/mix.js"
+ Add "lib/package/ffmpeg/lib/filter/resample.js"
+ Add "lib/package/ffmpeg/lib/io.js"
+ Add "lib/package/ffmpeg/lib/mux/adts.js"
+ Add "lib/package/ffmpeg/lib/mux/flac.js"
+ Add "lib/package/ffmpeg/lib/mux/mp3.js"
+ Add "lib/package/ffmpeg/lib/mux/mp4.js"
+ Add "lib/package/ffmpeg/lib/mux/ogg.js"
+ Add "lib/package/ffmpeg/lib/mux/wav.js"
+ Add "lib/package/ffmpeg/lib/pipeline.js"
+ Add "lib/package/ffmpeg/lib/probe.js"
+ Add "lib/package/ffmpeg/lib/tags.js"
+ Add "lib/package/ffmpeg/lib/util.js"
```
</sub>

<h3>24/November/2026</h3>
<sub>

```diff
• Migrate configuration system from `.env` and `lib/config.js` to a unified `config.jsonc` file with `config.example.jsonc` template
• Refactor configuration parsing and startup logic in `start.js` and `helper.js`
• Update AI prompt rules, MCP tool adapters, web server, and bot utilities to read settings from `global.config`
• Refactor file reload watcher, cluster workers, and handler utilities
• Add audio sticker support with Opus audio encoding, proto extensions, and `sendAudioSticker` helper in `simple.js`
• Update sticker plugins (`sticker.js`, `wm.js`) to support attached/quoted audio or audio URL for audio stickers
• Add `readviewonce` (`rvo`) tool plugin to retrieve and re-send viewOnce media messages with placeholder resend fallback
• Update `baileys` dependency version to `^0.4.3` in `package.json`

________________________

+ Add "config.example.jsonc"
+ Add "config.jsonc"
+ Add "plugins/tools/viewonce.js"
- Delete ".env.example"
- Delete "lib/config.js"
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
* Edit "plugins/sticker/wm.js"
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
