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

<h3>15/August/2026</h3>
<sub>

```diff
• Massive refactor of VoIP infrastructure: removed legacy/unused modules (lib/voip/*), streamlined signaling and transport logic
• Improved sticker metadata handling and watermark injection in plugins/sticker/
• Enhanced AI tools (lib/ai/mcp.js, lib/ai/tools/files.js) for better performance
• General cleanup and dependency updates in package.json
• Refactored core modules (lib/main.js, lib/simple.js) for better maintainability

________________________

* Edit "lib/voip/*"
* Edit "plugins/owner/call.js"
* Edit "lib/simple.js"
* Edit "lib/main.js"
- Delete "lib/sticker.js"
* Edit "lib/ai/mcp.js"
* Edit "plugins/sticker/*"
* Edit "lib/ai/mcp.js"
* Edit "lib/ai/tools/files.js"
```
</sub>
