08/Aug/2026
- Remove AGENT.md
- Update README.md badge layout
- Clean up package.json dependencies (add cheerio, remove unused)
- Refactor plugins.js to use Helper.checkSyntax
- Major refactor of lib/database.js, lib/converter.js, lib/helper.js
- Add lib/scraper/ytsearch.js
- Improve README.md badge layout and add license notice
- Update run_python description in lib/ai/tools/system.js
- Remove unused dependencies (human-readable, requests) in package.json
- Replace human-readable dependency with custom format function in plugins/main/ping.js
- Replace chalk dependency with custom local lib/color.js module
- Add Call feature to README
- Refactor youtube downloader scraper
- Update youtube downloader command
- Add Call feature (beta)

Modified files:
- README.md
- lib/ai/tools/system.js
- package.json
- plugins/main/ping.js
- lib/color.js
- lib/config.js
- lib/connection.js
- lib/database.js
- lib/handler.js
- lib/main.js
- lib/plugins.js
- lib/server.js
- lib/start.js
- plugins/_event/system.js
- AGENT.md
- lib/converter.js
- lib/helper.js
- lib/simple.js
- plugins/dl/yt.js
- plugins/owner/backup.js
- plugins/owner/exec.js
- lib/scraper/ytsearch.js
- lib/scraper/ytdl.js
- lib/voip/
- plugins/owner/call.js

____________________

07/Aug/2026
- Improve context info extraction for messages in lib/ai/mcp.js
- Minor updates in lib/ai/tools/messaging.js
- Refine system prompt rule 0.5 for reply handling in lib/ai/mcp.js
- Update plugins/ai/ai.js
- Update AI Agent documentation (plugin risk levels) in lib/ai/mcp.js
- Refactor plugin handling in lib/ai/tools/plugin.js
- Improve viewonce tool in plugins/tools/viewonce.js
- Refactor YouTube scraper to use https/dns with custom lookup and axios for improved stability in lib/scraper/ytdl.js, and update yt plugin

Modified files:
- lib/ai/mcp.js
- lib/ai/tools/messaging.js
- plugins/ai/ai.js
- lib/ai/tools/plugin.js
- plugins/tools/viewonce.js
- lib/scraper/ytdl.js
- plugins/dl/yt.js

____________________

06/Aug/2026
- Update AI Agent Guide (AGENT.md) to English
- Update README.md
- Refactor lib/ai/mcp.js
- Update changelog update instructions in mcp.js

Modified files:
- AGENT.md
- README.md
- lib/ai/mcp.js
