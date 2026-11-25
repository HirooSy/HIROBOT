// ---- This is an example, create your own config.js or just rename this file to config.js -----

export default {
    "prefix": [".", "/", "!"], // Set to [] to enable noPrefix mode, commands also work without a prefix
    "owner": [], // Fill owner & moderator using your own number, separate the numbers using coma, for example: ["628123456789", "628987654321"]. support pn whatsapp and discord user id
    "mods": [], // You dont need to fill the moderator, it's optional. only used for plugins that have (plugins.mods = true)
    "bot": {
        "name": "HIROBOT",
        // Support mongodb/MySql2/Local file sql
        // • mongodb+srv://...
        // • mysql://...
        // • dont fill it to use local file sql
        "database": "",
        "OnlyRespondTo": "all", // all, group, dm, status. For discord only all, group, and dm are available
        "queue": true,
        "cooldown": 3000,
        "didyoumean": true,
        "whatsapp": {
            "enable": true,
            "autoblocknumber": ["265", "234"],
            "autoTyping": false,
            "autoRead": true,
            "autoReactStatus": [false, ["🖤", "❤️"]],
            "connection": {
                "online": true,
                "loadhistory": true,
                "type": "sql", // multi, sql, single
                "browser": ["Windows", "Firefox", "10.0.22631"],
                "paircode": "",
                "qr": false,
                "maxSubbots": 100
            }
        },
        // Discord (optional, if you want run the discord bot too). — https://discord.com/developers/home
        "discord": {
            "enable": false,
            "token": "",
            "client_id": "",
            "client_secret": ""
        }
    },
    // Github (optional)
    "github": {
        "username": "",
        "email": "",
        "repository": "",
        "classic_key": "",
        "token": ""
    },
    "website": {
        "icon": "https://files.catbox.moe/imxgh6.png",
        "thumbnail": "https://cdn.savedly.net/mmspebwh",
        "description": "WhatsApp and Discord bot with an AI agent, VoIP call handling and a web panel. Link your number, run subbots, and manage gacha, shop and gift codes from the browser.",
        // Tunnel / Custom domain (optional)
        // See README.md -> "About Website" for full explanation of each scenario.
        "cloudflare": {
            "token": "",
            "hostname": "",
            "kv_token": "",
            "account_id": "",
            "kv_id": ""
        }
    },
    "canvas": {
        "font": "https://github.com/HirooSy/HirooSy/raw/refs/heads/main/arial.ttf"
    },
    
    "ai": {
        "name": "HIRO",
        "keys": [], // Gemini API Key (Free, Get from https://aistudio.google.com), example: ["key1", "key2", "key3"]
        "personality": "",
        "thinking": true,
        "autoheal": false,
        "outsideProjectAccess": {
            "read": true,
            "write": false
        },
        "loadStore": true,
        "limitHistory": 50,
        // default gemini voice: input number 0-100 ( <50 male, >50 — female)
        // voice prompt: input any text
        "voice": ""
    },
    "sticker_wm": ["H I R O   B O T", ""],
    "tier": {
        "0": {
            "name": "✧✧✧✧✧",
            "limitCapacity": 10
        },
        "1": {
            "name": "✦✧✧✧✧",
            "expRequired": 10000,
            "limitCapacity": 15
        },
        "2": {
            "name": "✦✦✧✧✧",
            "expRequired": 10000,
            "limitCapacity": 20
        },
        "3": {
            "name": "✦✦✦✧✧",
            "expRequired": 20000,
            "limitCapacity": 30
        },
        "4": {
            "name": "✦✦✦✦✧",
            "expRequired": 50000,
            "limitCapacity": 40
        },
        "5": {
            "name": "✦✦✦✦✦",
            "expRequired": 100000,
            "limitCapacity": 50
        }
    },
    "msg": {
        "rowner": "This command is only for developer bot",
        "owner": "This command is only for bot owners",
        "mods": "This command is only for bot moderators.",
        "premium": "This command is only for premium users.",
        "group": "This command can only be used in group chat.",
        "private": "This command can only be used in private chat",
        "admin": "This command can only be used by the admin group.",
        "botAdmin": "This command can only be used if the bot is an admin.",
        "restrict": "Restrict is disabled in this chat",
        "unreg": "Sorry User, You can only use this command after registering to the bot database."
    }
}
