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
    owner: resolveOwners(),
    mods: resolveMods(),
    icon: "https://files.catbox.moe/imxgh6.png",
    font: {
        source: "https://github.com/HirooSy/HirooSy/raw/refs/heads/main/arial.ttf",
    },
    
    ai: { 
        thinking: true, 
        autoheal: false,
        outsideProjectAccess: { read: true, write: false },
        loadStore: true,
        limitHistory: 50
        },
    
    connection: { 
        main: { 
            loadhistory: true,
            type: "sql", // sql, single, multi
            browser: ['Windows', 'Firefox', '10.0.22631'],
            paircode: "HIROHIRO",
            qr: false,
        },
        subbot: { 
            maxConnect: 100,
            autoConnect: true,
            loadhistory: false,
            type: "sql", // sql, single, multi
            paircode: "HIROHIRO",
            browser: ['Windows', 'Firefox', '10.0.22631'],
            qr: false,
           },
        },
    
    system: {
        online: false,
        autoTyping: false,
        autoRead: true, 
        OnlyRespondTo: "all",
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
        // you can add more
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