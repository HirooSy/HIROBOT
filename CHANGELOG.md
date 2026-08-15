<h3>15/August/2026</h3>
<sub>

```diff
• Massive refactor of VoIP infrastructure: removed legacy/unused modules (lib/voip/*), streamlined signaling and transport logic
• Improved sticker metadata handling and watermark injection in plugins/sticker/
• Enhanced AI tools (lib/ai/mcp.js, lib/ai/tools/files.js) for better performance
• General cleanup and dependency updates in package.json
• Refactored core modules (lib/main.js, lib/simple.js) for better maintainability

________________________

- Delete "lib/voip/signaling.js"
- Delete "lib/voip/wasm-engine.js"
- Delete "lib/sticker.js"
+ Add "lib/voip/modules/audio-feeder.js"
* Edit "lib/ai/mcp.js"
- const MCP_VERSION = "1.0.0";
+ const MCP_VERSION = "1.1.0";
* Edit "plugins/sticker/sticker.js"
- if (type === 'image') {
+ if (type === 'image' || type === 'video') {
```
</sub>
