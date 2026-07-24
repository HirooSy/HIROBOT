import { watchFile, unwatchFile, readFileSync } from 'fs'
import chalk from 'chalk'
import { fileURLToPath } from 'url'
import database from './database.js'

global.db = database
global.owner = JSON.parse(process.env.OWNER) || []
global.mods = JSON.parse(process.env.MODERATOR) || []

global.settings = {
    refillLimit: [1, 10], //limit, time(minute)
    }

const more = String.fromCharCode(8206)
global.readmore = more.repeat(4001)

global.tierAsset = JSON.parse(process.env.TIER) || {
  name: {
    '0': '✧✧✧✧✧',
    '1': '✦✧✧✧✧',
    '2': '✦✦✦✧✧',
    '3': '✦✦✦✧✧',
    '4': '✦✦✦✦✧',
    '5': '✦✦✦✦✦'
  },
  exp: { '1': 10000, '2': 20000, '3': 30000, '4': 50000, '5': 100000 },
  limit: { '0': 10, '1': 15, '2': 20, '3': 30, '4': 40, '5': 50 }
}

let file = fileURLToPath(import.meta.url)
watchFile(file, () => {
  unwatchFile(file)
  console.log(chalk.redBright("Update 'config.js'"))
  import(`${file}?update=${Date.now()}`)
})