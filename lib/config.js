import scraper from "./scrapers/index.js"

const more = String.fromCharCode(8206)
global.readmore = more.repeat(4001)
process.env.TMPDIR = process.cwd() + "/data/tmp"
global.scraper = scraper

function resolveOwners() {
    return !!process.env.OWNER ? process.env.OWNER.split(",").map(v => v.trim()).filter(Boolean).map(v => [v, "", true]) : [["", "", true]]
}

function resolveMods() {
    return !!process.env.MODERATOR ? process.env.MODERATOR.split(",").map(v => v.trim()).filter(Boolean) : [""]
}

export function refreshOwnersAndMods() {
    global.settings.owner = resolveOwners()
    global.settings.mods = resolveMods()
}

global.settings = {
    botname: "HIROBOT",
    bot: { whatsapp: true, discord: false },
    owner: resolveOwners(),
    mods: resolveMods(),
    website: {
        icon: "https://files.catbox.moe/imxgh6.png",
        thumbnail: "https://cdn.savedly.net/mmspebwh",
        description: "AI-powered, Lightweight & High-performance bot. Connect the bot to your account, setting it up as you like."
    },
    font: {
        source: "https://github.com/HirooSy/HirooSy/raw/refs/heads/main/arial.ttf",
    },
    
    ai: { 
        thinking: true, 
        autoheal: false,
        outsideProjectAccess: { read: true, write: false },
        loadStore: true,
        limitHistory: 50,
        voice: "man voice like, kinda slow, very heavy, flat."
        /** Voice config
         • default gemini voice: input number 0-100 ( <50 male, >50 — female)
         • voice prompt: input any text
        **/
        },
    
    connection: {
        loadhistory: true,
        type: "sql", // multi, sql, single
        browser: ['Windows', 'Firefox', '10.0.22631'],
        paircode: "HIROHIRO",
        qr: false,
        maxSubbots: 100,
    },
    
    system: {
        online: false,
        autoTyping: false,
        autoRead: true, 
        OnlyRespondTo: "all", // all, group, dm, status
        queue: true,
        noPrefix: false,
        prefix: [".", "/", "!"],
        cooldown: 3000,
        autoReactStatus: [ false, ["🖤", "❤️"] ],
        didyoumean: true,
        autoblocknumber: ['265', '234'],
        },
    
    tier: {
        0: { name: "✧✧✧✧✧", limitCapacity: 10 },
        1: { name: "✦✧✧✧✧", expRequired: 10000, limitCapacity: 15 },
        2: { name: "✦✦✧✧✧", expRequired: 10000, limitCapacity: 20 },
        3: { name: "✦✦✦✧✧", expRequired: 20000, limitCapacity: 30 },
        4: { name: "✦✦✦✦✧", expRequired: 50000, limitCapacity: 40 },
        5: { name: "✦✦✦✦✦", expRequired: 100000, limitCapacity: 50 }
      },
    sticker_wm: ["H I R O   B O T", ""],
    msg: {
        rowner: 'This command is only for developer bot',
        owner: 'This command is only for bot owners',
        mods: 'This command is only for bot moderators.',
        premium: 'This command is only for premium users.',
        group: 'This command can only be used in group chat.',
        private: 'This command can only be used in private chat',
        admin: 'This command can only be used by the admin group.',
        botAdmin: 'This command can only be used if the bot is an admin.',
        restrict: 'Restrict is disabled in this chat',
        unreg: 'Sorry User, You can only use this command after registering to the bot database.'
        }
   }