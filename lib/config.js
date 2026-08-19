import { watchFile, unwatchFile, readFileSync } from 'fs'
import chalk from './utils/color.js'
import { fileURLToPath } from 'url'
import { Browsers } from 'baileys'
import scraper from "./scrapers/index.js"

const more = String.fromCharCode(8206)
global.readmore = more.repeat(4001)
process.env.TMPDIR = process.cwd() + "/data/tmp"
global.scraper = scraper

global.settings = {
    botname: "HIROBOT",
    owner: !!process.env.OWNER ? JSON.parse(process.env.OWNER) : [""],
    mods: !!process.env.MODERATOR ? JSON.parse(process.env.MODERATOR) : [""],
    icon: "https://i.ibb.co.com/qPn4dND/Untitled61-20260717233557.png",
    
    ai: { 
        thinking: true, 
        autoheal: false
        },
    
    connection: { 
        main: { 
            loadhistory: false,
            file: "data/sessions/main.session",
            browser: Browsers.windows('Firefox'),
            paircode: "HIROHIRO",
        },
        caller: {  
            file: "data/sessions/caller.session",
            paircode: "HIROHIRO",
            browser: Browsers.windows('Safari'),
            },
        subbot: { 
            maxConnect: 3,
            autoConnect: true,
            loadhistory: false,
            paircode: "HIROHIRO",
            file: "data/sessions/subbot/[number].session",
            browser: Browsers.windows('Firefox'),
           },
        },
    
    system: {
        online: true,
        autoTyping: true,
        autoRead: true, 
        OnlyRespondTo: "all", //group, status, dm
        queue: true,
        noPrefix: false,
        prefix: [".", "/", "!"],
        cooldown: 3000, //cooldown command in ms
        autoReactStatus: [ false, ["🖤", "❤️"] ],
        },
    
    tier: {
        name: [ '✧✧✧✧✧', '✦✧✧✧✧', '✦✦✦✧✧', '✦✦✦✧✧', '✦✦✦✦✧', '✦✦✦✦✦' ],
        exp_required: [ 10000, 20000, 30000, 50000, 100000 ],
        limit_capacity: [ 10, 15, 20, 30, 40, 50 ]
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

let file = fileURLToPath(import.meta.url)
watchFile(file, () => {
  unwatchFile(file)
  import(`${file}?update=${Date.now()}`)
})