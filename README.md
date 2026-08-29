<div align=center>
<a href="#"><img src="https://files.catbox.moe/tl36qw.png"/></a> 

  <a href="https://github.com/whiskeysockets/baileys"><img height="25" src="https://img.shields.io/badge/Baileys-000000?style=for-the-badge&logo=whatsapp&logoColor=green"/></a><a href="#"><img height="25" src="https://img.shields.io/badge/NodeJS-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green"/></a><a href="https://gemini.google.com"><img height="25" src="https://img.shields.io/badge/Gemini-000000?style=for-the-badge&logo=googlegemini&logoColor=blue"/></a><a href="https://cloudflare.com"><img height="25" src="https://img.shields.io/badge/Cloudflare-000000?style=for-the-badge&logo=Cloudflare&logoColor=orange"/></a>
</div>

<p align=center><sub><sub>· ✦ ·</sub></sub></p>

<p align=center><sub>Hirobot is A Lightweight WhatsApp bot that integrates an AI agent, VoIP calling capabilities, and a dedicated web portal for users. Built with Baileys and NodeJS v24+.</sub></p>

#### Features: 
- [x] <sub> AI Agent Using Gemini.</sub>
- [x] <sub> 1:1 Voice & Video Call. </sub>
- [x] <sub> Multi Sessions. </sub> 
- [x] <sub> Database Node:Sqlite / Mongodb / MySQL.</sub>
- [x] <sub> Support AI Rich and Button Message.</sub>
- [x] <sub> Cloudflared Tunnel Website.</sub>

---

<table align=center height=100>
  <td>
  <sub>
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
│   ├── 📄config.js        # set your bot's preference here
│   ├── 📄main.js
│   └── 📄start.js
├── 📁data
│   ├── 📁sessions
│   ├── 📁tunnel
│   └── 📁tmp
├── 📁plugins
├── 📄.env                 # Set your tokens here
├── 📄CHANGELOG.md
├── 📄LICENSE
├── 📄package.json
└── 📄README.md
```
</sub>
</sub>
  </td>
</table>

<div align=center><a href="https://github.com/HirooSy/HIROBOT/blob/main/CHANGELOG.md"><img height="17" src="https://img.shields.io/badge/Change_log-006600.svg?&style=for-the-badge&logo=files&logoColor=white"/></a>
  <a href="https://github.com/HirooSy/HIROBOT/discussions"><img height="17" src="https://img.shields.io/badge/Discussion-ffffff.svg?&style=for-the-badge&logo=livechat&logoColor=black"/></a></div><br>


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

 | AI Model | Usage |
 |---|---|
 | <sub>Gemini 3.1 Lite-Flash</sub> | <sub>Daily conversation</sub> |
 | <sub>Gemini 3.1 Lite</sub> | <sub>Daily conversation but more complex</sub> |
 | <sub>Gemma-4-31b-it</sub> | <sub>AutoHeal system and coding</sub> |
 | <sub>Gemma-4-26b-a4b-it</sub> | <sub>AutoHeal system and coding</sub> |

<h4 align=center>How to add a new tool</h4>
  
<details>
  <summary align=center><sub>All MCP Helper</sub></summary>

  <table align=center height=100>
  <td>
<sub>
  
```
-- Session / chat history --
getSession(jid)                  get chat history array for a chat
resetSession(jid)                clear chat history for a chat
getPinnedNotesReadOnly(jid)      get notes pinned to a chat

-- Talking to the AI / agent loop --
runAgent(conn, m, text, opts)     run a full AI turn, get a reply
runAgentConfirmed(conn, m, opts)  resume an agent turn awaiting confirmation
callTool(name, args)             call another registered tool by name
listTools() / countTools()       list / count registered tools

-- Identity & permissions --
getUserIdentity(jid, db, conn)    get sender's name/number/owner/timezone
checkGroupAdminOrOwner(groupJid)  check if sender is group admin/owner
readGroupSettings(groupJid)       read group settings from brain storage
readOwnerList()                   list registered bot owners

-- Persistent storage ("brain") --
loadBrain() / saveBrain(brain)         read/write ai-brain.json
ensureBrainGroupSlot(brain, jid)       ensure a group slot exists in brain

-- Web & media --
searchWebGrounded(query)                     grounded web search
captureWebsiteScreenshot(url)                screenshot a webpage
fetchWebsiteHtmlFallback(url)                fetch raw HTML of a page
peekFetchBuffer(url, headers)                peek a file buffer from a URL
peekfetchVideoBuffer(url, maxBytes, headers) peek a video buffer from a URL
detectPlatform(url)                          detect platform (YouTube/TikTok/etc)
peekAnalyzeWithVision(mediaItems, platform, url, context)  analyze media with vision model
buildMediaPart(m)                            extract image/video/audio from a message
fetchSocialMulti(url)                         download helper for social media
downloadUserImageAsUrl(m)                    upload user's image, get back a URL

-- File & data tools --
readFileToolCore(file_path, offset)   core logic behind "read file" tool
buildSimpleDiff(oldStr, newStr)       build a text diff between two strings
parseDbKeyPath(key_path)              parse a dotted key path for db access

-- Plugin execution (advanced/internal) --
resolvePlugin(command)                      find which plugin matches a command
              resolveCustomPrefixPlugin(rawInput)         same, for custom-prefix commands
execPluginCommand(command, argsStr, opts)   run an existing bot plugin/command
execEval(code, opts)                        evaluate raw JS code (owner-only, dangerous)
classifyPluginRisk(name, plugin)            classify a plugin's risk level
accessLabel(level) / riskBadge(level)       risk-level label/badge helpers
pluginRequirements(plugin)                  get a plugin's access requirements
getDangerousDocReason(m)                    check if a message/doc looks risky

-- Error handling & internals (rarely needed in tools) --
handleError(conn, m, err, pluginName)   central error handler/reporter
isTransientApiError(err)                check if an API error is transient
getApiKeys() / getNextKey() / rotateKey() / resetRateLimit(jid)  API key pool mgmt
normalizeApiKeys(input)                 format/clean a raw API key list
getPersonality()                        get bot's configured personality/system prompt
MODELS                                  map of available AI models
setCurrentContext(...) / hasPending() / confirmPending() / cancelPending()
internal turn/state mgmt (used by mcp.js itself)
  ```
</sub>
</td>
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

<details> <summary><sub>📖 Basic</sub></summary>
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

<details> <summary><sub>📍 Location Interactive</sub></summary>
  <sub>
  
```javascript
conn.sendLocUrl(
        m.chat,
        'https://example.com/thumb.jpg',
        'Title',
        'Address',
        'Text',
        'Footer',
        'https://example.com',
         m )
```

</sub></details>

<details> <summary><sub>🖼️ Url Preview</sub></summary>
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

<details> <summary><sub>🛒 Carousel</sub></summary>
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

<details> <summary><sub>🔖 NativeFlow Button</sub></summary>
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

<details> <summary><sub>🗓️ AI Rich</sub></summary>
  <sub>

```javascript
await conn.aiRich()
    .setTitle('Ai Rich Message') 
    .addText('[HyperLink](https://example.com)\nCitation [](https://example.com)'\n[x^2+y^2=r^2|100|100](https://example.com/latex.png))
    .addImage('https://example.com/image.png')
    .addCode('javascript', `console.log('Hello World')`)
    .addTable([
        ['Name', 'HirooSy'],
        ['Bio', 'Im developer'],
        ['Age', '67']
    ])
    .addSource([['https://example.com/favicon.ico', 'https://example.com', 'Source']])
    .addTip('Tip Text')
    .addSuggest(['Continue', 'Cancel'])
    .send(m.chat, { quoted: m })
```
</sub></details>

<details> <summary><sub>📦 Sticker</sub></summary>
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

<details> <summary><sub>📞 Call</sub></summary>
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

   <table height="100" align=center>
       <tr>
         <td>REQUIREMENT</td>
         <td>Detail</td>
         <td>Install</td>
       </tr>
     <tr>
     <td><b>Server</b></td>
     <td><sub>500MB RAM, 1GB Storage, Support IP:Port</sub></td>
     <td>-</td>
   </tr>
     <tr>
     <td><b>NodeJS</b></td>
     <td><sub>24 or higher</sub></td>
     <td><sub><code>pkg install nodejs</code></sub></td>
     </tr>
     <tr>
       <td><b>Python</b></td>
       <td><sub>Python 3.10+</sub></td>
       <td><sub><code>pkg install python</code></sub></td>
     </tr>
     <tr>
       <td><b>FFMPEG</b></td>
       <td><sub>latest</sub></td>
       <td><sub><code>pkg install ffmpeg</code></sub></td>
     </tr>
   </table>

<sub align=left>

```bash
$ git clone https://github.com/HirooSy/HIROBOT.git
$ mv .env.example .env
$ nano .env
$ node .
```
</sub>

<div align=center>

  <a href="#"><img height="22" align=right src="https://img.shields.io/badge/Size-120_MB-black?style=for-the-badge"/> </a>
  
  <a href="https://replit.com"><img height="22" align=left src="https://img.shields.io/badge/Deploy-black?style=for-the-badge&logo=replit"/></a>

</div>

</details>