import { watchFile, unwatchFile, readFileSync } from 'fs'
import chalk from './color.js'
import { fileURLToPath } from 'url'

const more = String.fromCharCode(8206)
global.readmore = more.repeat(4001)
process.env.TMPDIR = process.cwd() + "/data/tmp"

global.settings = {
    owner: !!process.env.OWNER ? JSON.parse(process.env.OWNER) : [""],
    mods: !!process.env.MODERATOR ? JSON.parse(process.env.MODERATOR) : [""],
    icon: "https://i.ibb.co.com/qPn4dND/Untitled61-20260717233557.png",
    ai: { 
        thinking: true, 
        autoheal: false
        },
    subbot: { 
         maxConnect: 3,
         autoConnect: true,
         path: "data/sessions/subbot"
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
  console.log(chalk.greenBright("Update 'config.js'"))
  import(`${file}?update=${Date.now()}`)
})