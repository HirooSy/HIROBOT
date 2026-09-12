<div align=center>
<a href="#"><img src="https://files.catbox.moe/tl36qw.png"/></a> 

  <a href="https://github.com/whiskeysockets/baileys"><img height="22" src="https://img.shields.io/badge/Baileys-000000?style=for-the-badge&logo=whatsapp&logoColor=green"/></a><a href="#"><img height="22" src="https://img.shields.io/badge/NodeJS-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green"/></a><a href="https://gemini.google.com"><img height="22" src="https://img.shields.io/badge/Gemini-000000?style=for-the-badge&logo=googlegemini&logoColor=blue"/></a><a href="https://cloudflare.com"><img height="22" src="https://img.shields.io/badge/Cloudflare-000000?style=for-the-badge&logo=Cloudflare&logoColor=orange"/></a>
</div>

> [!NOTE]
> Hirobot is A Lightweight WhatsApp bot that integrates an AI agent, VoIP calling capabilities, and a dedicated web portal for users. Built with Baileys and NodeJS v24+.
> 
> ---
> 
> <p align=center><b>Features:</b></p>
> 
> - [x] AI Agent Using Gemini.
> - [x] 1:1 Voice & Video Call.
> - [x] Multi Sessions.
> - [x] Database Node:Sqlite / Mongodb.
> - [x] Support AI Rich and Button Message.
> - [x] Cloudflared Tunnel Website.
> - [x] Minimal Depedencies.

---

<table align=center height=100>
  <td>
  <sub>
    
```env
         ---Project Structure---
HIROBOT
├── 📁lib
│   ├── 📁package
│   │   ├── 📁ai            
│   │   ├── 📁voip           # Call
│   │   └── 📁website
│   │       ├── 📁views      # HTML folder
│   │       └── 📄server.js
│   ├── 📁scrapers
│   ├── 📁utils
│   ├── 📄config.js        # bot's preference
│   ├── 📄main.js
│   └── 📄start.js
├── 📁data
│   ├── 📁sessions
│   ├── 📁tunnel
│   └── 📁tmp
├── 📁plugins
├── 📄.env                 # your tokens
├── 📄CHANGELOG.md
├── 📄LICENSE
├── 📄package.json
└── 📄README.md
```
</sub>

  </td>
</table>

<div align=center><a href="https://github.com/HirooSy/HIROBOT/blob/main/CHANGELOG.md"><img height="20" src="https://img.shields.io/badge/Change_log-006600.svg?&style=for-the-badge&logo=files&logoColor=white"/></a>
  <a href="https://github.com/HirooSy/HIROBOT/discussions"><img height="20" src="https://img.shields.io/badge/Discussion-ffffff.svg?&style=for-the-badge&logo=livechat&logoColor=black"/></a></div><br>


<details> 
  <summary align=left><b>About AI Agent</b></summary>
<p align=center>──────────────</p>

<h4 align=center >How AutoHeal Works?</h4>

> ```mermaid
> flowchart LR
>     A@{ shape: odd, label: "User Command" } --> Error
>     Error process@==> C@{ shape: diamond, label: "Gemini Server
> Gemma-4-31b-it"}
>     C --> D@{ shape: circle, label: "⏳" }
>     D ==> E[✅ Write and save]
>     D ==> F[❌ Stop autoheal]
>     E --> G[Done]
>     F --> H[Note it as failure]
>
> process@{ animate: true }
> style Error stroke:#f00
> ```

<table align=center>
  <tr>
    <td>Gemini 3.1 Lite-Flash</td>
    <td>Daily Conversation </td>
  </tr>
  <tr>
    <td>Gemini 3.1 Lite</td>
    <td>Daily conversation but more complex</td>
  </tr>
 <tr>
    <td>Gemma-4-31b-it</td>
    <td>AutoHeal system and coding</td>
  </tr>
  <tr>
    <td>Gemma-4-26b-a4b-it</td>
    <td>AutoHeal system and coding</td>
  </tr>
</table>

<h4 align=center>How to add a new tool</h4>
  
<details>
  <summary align=center><sub>All MCP Helper</sub></summary>
  
<table>
  <thead>
    <tr>
      <th>Category</th>
      <th>Function</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td rowspan="3"><strong>Session &amp; Chat History</strong></td>
      <td><code>getSession(jid)</code></td>
      <td>get chat history array for a chat</td>
    </tr>
    <tr>
      <td><code>resetSession(jid)</code></td>
      <td>clear chat history for a chat</td>
    </tr>
    <tr>
      <td><code>getPinnedNotesReadOnly(jid)</code></td>
      <td>get notes pinned to a chat</td>
    </tr>
    <tr>
      <td rowspan="4"><strong>Talking to the AI / Agent Loop</strong></td>
      <td><code>runAgent(conn, m, text, opts)</code></td>
      <td>run a full AI turn, get a reply</td>
    </tr>
    <tr>
      <td><code>runAgentConfirmed(conn, m, opts)</code></td>
      <td>resume an agent turn awaiting confirmation</td>
    </tr>
    <tr>
      <td><code>callTool(name, args)</code></td>
      <td>call another registered tool by name</td>
    </tr>
    <tr>
      <td><code>listTools() / countTools()</code></td>
      <td>list / count registered tools</td>
    </tr>
    <tr>
      <td rowspan="4"><strong>Identity &amp; Permissions</strong></td>
      <td><code>getUserIdentity(jid, db, conn)</code></td>
      <td>get sender's name/number/owner/timezone</td>
    </tr>
    <tr>
      <td><code>checkGroupAdminOrOwner(groupJid)</code></td>
      <td>check if sender is group admin/owner</td>
    </tr>
    <tr>
      <td><code>readGroupSettings(groupJid)</code></td>
      <td>read group settings from brain storage</td>
    </tr>
    <tr>
      <td><code>readOwnerList()</code></td>
      <td>list registered bot owners</td>
    </tr>
    <tr>
      <td rowspan="2"><strong>Persistent Storage (&quot;brain&quot;)</strong></td>
      <td><code>loadBrain() / saveBrain(brain)</code></td>
      <td>read/write ai-brain.json</td>
    </tr>
    <tr>
      <td><code>ensureBrainGroupSlot(brain, jid)</code></td>
      <td>ensure a group slot exists in brain</td>
    </tr>
    <tr>
      <td rowspan="10"><strong>Web &amp; Media</strong></td>
      <td><code>searchWebGrounded(query)</code></td>
      <td>grounded web search</td>
    </tr>
    <tr>
      <td><code>captureWebsiteScreenshot(url)</code></td>
      <td>screenshot a webpage</td>
    </tr>
    <tr>
      <td><code>fetchWebsiteHtmlFallback(url)</code></td>
      <td>fetch raw HTML of a page</td>
    </tr>
    <tr>
      <td><code>peekFetchBuffer(url, headers)</code></td>
      <td>peek a file buffer from a URL</td>
    </tr>
    <tr>
      <td><code>peekfetchVideoBuffer(url, maxBytes, headers)</code></td>
      <td>peek a video buffer from a URL</td>
    </tr>
    <tr>
      <td><code>detectPlatform(url)</code></td>
      <td>detect platform (YouTube/TikTok/etc)</td>
    </tr>
    <tr>
      <td><code>peekAnalyzeWithVision(mediaItems, platform, url, context)</code></td>
      <td>analyze media with vision model</td>
    </tr>
    <tr>
      <td><code>buildMediaPart(m)</code></td>
      <td>extract image/video/audio from a message</td>
    </tr>
    <tr>
      <td><code>fetchSocialMulti(url)</code></td>
      <td>download helper for social media</td>
    </tr>
    <tr>
      <td><code>downloadUserImageAsUrl(m)</code></td>
      <td>upload user's image, get back a URL</td>
    </tr>
    <tr>
      <td rowspan="3"><strong>File &amp; Data Tools</strong></td>
      <td><code>readFileToolCore(file_path, offset)</code></td>
      <td>core logic behind &quot;read file&quot; tool</td>
    </tr>
    <tr>
      <td><code>buildSimpleDiff(oldStr, newStr)</code></td>
      <td>build a text diff between two strings</td>
    </tr>
    <tr>
      <td><code>parseDbKeyPath(key_path)</code></td>
      <td>parse a dotted key path for db access</td>
    </tr>
    <tr>
      <td rowspan="7"><strong>Plugin Execution (Advanced/Internal)</strong></td>
      <td><code>resolvePlugin(command)</code></td>
      <td>find which plugin matches a command</td>
    </tr>
    <tr>
      <td><code>resolveCustomPrefixPlugin(rawInput)</code></td>
      <td>same, for custom-prefix commands</td>
    </tr>
    <tr>
      <td><code>execPluginCommand(command, argsStr, opts)</code></td>
      <td>run an existing bot plugin/command</td>
    </tr>
    <tr>
      <td><code>execEval(code, opts)</code></td>
      <td>evaluate raw JS code (owner-only, dangerous)</td>
    </tr>
    <tr>
      <td><code>classifyPluginRisk(name, plugin)</code></td>
      <td>classify a plugin's risk level</td>
    </tr>
    <tr>
      <td><code>accessLabel(level) / riskBadge(level)</code></td>
      <td>risk-level label/badge helpers</td>
    </tr>
    <tr>
      <td><code>pluginRequirements(plugin)</code></td>
      <td>get a plugin's access requirements</td>
    </tr>
    <tr>
      <td><code>getDangerousDocReason(m)</code></td>
      <td>check if a message/doc looks risky</td>
    </tr>
    <tr>
      <td rowspan="8"><strong>Error Handling &amp; Internals</strong></td>
      <td><code>handleError(conn, m, err, pluginName)</code></td>
      <td>central error handler/reporter</td>
    </tr>
    <tr>
      <td><code>isTransientApiError(err)</code></td>
      <td>check if an API error is transient</td>
    </tr>
    <tr>
      <td><code>getApiKeys() / getNextKey() / rotateKey() / resetRateLimit(jid)</code></td>
      <td>API key pool management</td>
    </tr>
    <tr>
      <td><code>normalizeApiKeys(input)</code></td>
      <td>format/clean a raw API key list</td>
    </tr>
    <tr>
      <td><code>getPersonality()</code></td>
      <td>get bot's configured personality/system prompt</td>
    </tr>
    <tr>
      <td><code>MODELS</code></td>
      <td>map of available AI models</td>
    </tr>
    <tr>
      <td><code>setCurrentContext(...)</code></td>
      <td>internal turn/state management (used by mcp.js itself)</td>
    </tr>
    <tr>
      <td><code>hasPending() / confirmPending() / cancelPending()</code></td>
      <td>internal turn/state management (used by mcp.js itself)</td>
    </tr>
  </tbody>
</table>

</div>
</details>

<sub>
  
```javascript
/*
  ctx()   -> Returns the current chat state (always fresh, backed by an
             internal module-level object in mcp.js). Common fields:
               - currentJid : the id of the chat/user sending the message
               - conn       : the active WhatsApp connection (for manual sendMessage)
               - isOwner    : true if the sender is the bot owner
               - isROwner   : true if the sender is a "real" owner (not fromMe)
               - timezone   : sender's configured timezone, e.g. "Asia/Jakarta"

  Tools import helpers straight from '../mcp.js'. There's no circular-import
  issue: mcp.js never statically imports files in ./tools -- it loads them
  with a dynamic import() at runtime (see loadToolsDir), so importing mcp.js
  from a tool file at the top level is completely safe.
*/
import { ctx, searchWebGrounded } from '../mcp.js'

export default [
    {
        name: 'check_weather',
        description: 'Check the weather for a specific city. Use it when a user asks for the weather, e.g., "What\'s the weather like in Jakarta?"',
        parameters: {
            city: { type: 'string', description: 'City name, e.g. "Jakarta"', required: true }
        },
        execute: async ({ city }) => {
            const { currentJid } = ctx()
            if (!currentJid) return 'Chat context not available'

            // const result = await searchWebGrounded(`current weather in ${city}`) // only if you need a helper from mcp.js

            return `Weather in ${city}: sunny, 30°C`
        }
    }
]
```

</sub>
</details>

<details>
   <summary align=left><b>Message types</b></summary>
   <p align=center>──────────────</p>

<details> <summary>📖 Basic</summary>
  <sub>
    
```javascript
conn.reply(m.chat, 'Hello world!', m)

/** @Media
URL — 'https://example.com/audio.mp3'
Local — '/path/to/video.mp4'

@Options
send as document — { document:true }
send as voicenote — { ptt: true }
**/
conn.sendFile(m.chat, media, "file.png", "hello world!", m, { options })

conn.sendContact(m.chat, [
  ['6281234567890', 'HirooSy'],
  ['6289876543210', 'Hiro']
], m)

conn.react(m.chat, '👍', m.key)
```
</sub></details>

<details> <summary>📍 Location</summary>
  <sub>
  
```javascript
conn.sendLocation(m.chat, 'https://example.com/thumb.jpg','Title','Address',m)
```

</sub></details>

<details> <summary>🧾 Product</summary>
  <sub>
 
```javascript
/**@Media
   String: "https://example.com/img.png" / "./image.png"
   Array: [ "https://example.com/", "./img.png" ]
**/
      
conn.sendProduct(m.chat, media, 'Title', 'Description, m, {
    businessOwnerJid: "0@s.whatsapp.net",
    currencyCode: 'USD',
    priceAmount1000: 20,
    retailerId: 'Code Promo',
})
```

</sub></details>

<details> <summary>🖼️ Url Preview</summary>
  <sub>
    
```javascript
conn.sendUrlPreview(
  m.chat,
  'https://example.com/thumb.jpg',
  'https://example.com Hello World!',
  'Url Preview Title',
  'Url Description',
  'IMAGE',   // true for highQuality, or ['IMAGE', true]
  m
)
```
</sub></details>

<details> <summary>🛒 Carousel</summary>
  <sub>
    
```javascript
conn.sendButton(m.chat, {
    text: 'Interactive with Carousel!',
    footer: 'HirooSy',
    cards: [
        {
            image: { url: './path/to/image.jpg' },
            caption: 'Image 1',
            footer: 'Image 1',
            nativeFlow: [{ text: 'Source', url: 'https://example.com', useWebview: true }]
        },
        {
            image: { url: 'https://example.com/image.png' },
            caption: 'Image 2',
            footer: 'Image 2',
            ltoText: 'New Coupon!',
            ltoCode: 'HiroBot',
            ltoUrl: 'https://example.com',
            nativeFlow: [{ text: 'Source', url: 'https://example.com' }]
        }
    ]
}, m)
```
</sub></details>

<details> <summary>🔖 NativeFlow Button</summary>
  <sub>

```javascript
conn.sendButton(m.chat, {
    image: { url: './path/to/image.jpg' },
    caption: 'Interactive!',
    footer: 'My Bot',
    optionText: 'Select Options',
    optionTitle: 'Select Options',
    ltoText: 'HirooSy',
    ltoCode: 'Hiro bot',
    ltoUrl: 'https://example.com',
    nativeFlow: [
        { text: '👋🏻 Greeting', id: '#Greeting' },
        { text: '📞 Call', call: '628123456789' },
        { text: '📋 Copy', copy: 'Hiro bot' }, 
        { text: '🌐 Source', url: 'https://example.com', useWebview: true },
        {
            text: '📋 Select',
            sections: [
                { title: '✨ Section 1', rows: [{ header: '', title: '🏷️ Coupon', description: '', id: '#CouponCode' }] },
                { title: '✨ Section 2', highlight_label: '🔥 Popular', rows: [{ header: '', title: '💭 Secret Ingredient', description: '', id: '#SecretIngredient' }] }
            ],
        }
    ]
}, m)
```
</sub></details>

<details> <summary>🗓️ AI Rich</summary>
  <sub>

```javascript
await conn.aiRich()
    .setTitle('Ai Rich Message') 
    .addText('[HyperLink](https://example.com)\nCitation [](https://example.com)'\n[x^2+y^2=r^2|100|100](https://example.com/latex.png))
    .addImage('https://example.com/image.png')
    .addCode('javascript', `console.log('Hello World')`)
    .addHtml(["<html>Hello world</html>", "Tab 1"], ["<html>Hi twin</html>", "Tab 2"]),
    .addTable([
        ['Name', 'HirooSy'],
        ['Bio', 'Im developer'],
        ['Age', '67']
    ])
    .addSource([['https://example.com/favicon.ico', 'https://example.com', 'Source']])
    .addTip('Tip Text')
    .addSuggest(['Continue', 'Cancel'])
    .send(m.chat, { quoted: m })
      
 // animated progress
 await conn.aiRich()
  .addProcess("Loading...")
  .send(m.chat)
```
</sub></details>

<details> <summary>📦 Sticker</summary>
  <sub>

```javascript
/** @Media
URL — 'https://example.com/image.png'
Local — '/path/to/image.png'
**/

// Sticker
conn.sendSticker(m.chat, media, { packname: "Hiro", author: "Bot" }, m)
 
// StickerPack
conn.sendStickerPack(m.chat, {
   cover: { url: media },
   stickers: [
      { data: { url: media } },
      { data: { url: media } },
   ],
   name: 'My Sticker Pack',
   publisher: 'Publisher stickerpack',
   description: 'Description pack'
})
```
</sub></details>

<details> <summary>📞 Call</summary>
  <sub>

```javascript
/** @Media
URL — 'https://example.com/audio.mp3'
Local — '/path/to/video.mp4'
**/

// Audio
const call = await conn.call('628123456789', media)

// Video
const call = await conn.call('628123456789', media, {
  videoSource: media
})

// Silent
const call = await conn.call('628123456789', 'silence')

// Audio as video call
const call = await conn.call('628123456789', Audio, {
  isVideo: true
})
```
</sub></details>
</details>
  
<details>
   <summary><b>Install and Run</b></summary><br>

<table align="center">
  <tbody>
    <tr>
      <td rowspan="4"><b>REQUIREMENT</b></td>
      <td><b>Server</b></td>
      <td colspan="2">500MB RAM, 1GB Storage, Support IP:Port <br> <code>-</code></td>
    </tr>
    <tr>
      <td><b>NodeJS</b></td>
      <td colspan="2">24 or higher <br> <code>pkg install nodejs</code></td>
    </tr>
    <tr>
      <td><b>Python</b></td>
      <td colspan="2">Python 3.10+ <br> <code>pkg install python</code></td>
    </tr>
    <tr>
      <td><b>FFMPEG</b></td>
      <td colspan="2">latest <br> <code>pkg install ffmpeg</code></td>
    </tr>
  </tbody>
</table>

<sub align=left>

```bash
$ git clone https://github.com/HirooSy/HIROBOT.git
$ cd HIROBOT
$ mv .env.example .env
$ nano .env
$ node .
```
</sub>

<div align=center>

  <a href="#"><img height="25" align=right src="https://img.shields.io/badge/Size-100_MB-black?style=for-the-badge"/> </a>
  
  <a href="https://wispbyte.com"><img height="25" align=left src="https://img.shields.io/badge/Deploy-black?style=for-the-badge&logo=4chan&logoColor=blue"/></a>

</div>

</details>