<h3>16/August/2026</h3>
<sub>

```diff
• Simplify contextInfo retrieval and clean up internal helper comments
• Refine AI instructions for gitpush workflow, clarifying that code diffs shouldn't be included in CHANGELOG.md
• Change auto-install dependency from 'caller' to 'wrtc' utilizing the same @roamhq/wrtc package under clean naming
• Adjust GitHub plugin risk assessment to 'low' allowing safe AI-driven repository synchronization

________________________

+ Add "CHANGELOG.md"
* Edit "lib/ai/mcp.js"
* Edit "lib/voip/voip.js"
* Edit "plugins/owner/github.js"
```
</sub>

---

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