console.clear()

import dotenv from 'dotenv'
import { join, dirname } from 'path'
dotenv.config({ path: join(process.cwd(), '.env'), quiet: true })
import chalk from 'chalk'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { setupMaster, fork } from 'cluster'
import { watchFile, unwatchFile } from 'fs'
import cfonts from 'cfonts'
import { createInterface } from 'readline'
import Helper from './lib/helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(__dirname)
const { say } = cfonts
const rl = createInterface(process.stdin, process.stdout)

say(`HIRO BOT`, { font: 'tiny', align: 'left', colors: ['yellow']})
say('Simple Bot Whatsapp', { font: 'console', align: 'left', colors: ['yellow', 'blue'] })
say('__________________________________', { font: 'console', align: 'left', colors: ['yellow'] })

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const RESTART_WINDOW_MS = 5 * 60 * 1000
const MAX_RESTART_COUNT = 5
const RESTART_DELAY_MS = 3000
const MAX_DELAY_MS = 60_000

var isRunning = false
var intentionalReset = false
var restartCount = 0
var lastRestartTime = Date.now()

let currentProcess = null

async function start(file) {
  if (isRunning) return
  isRunning = true

  // --cleartmp / --autoread bukan flag Node.js — itu opsi custom aplikasi
  // yang dibaca Helper.opts dari process.argv, jadi harus masuk `args`
  // (argumen skrip), BUKAN execArgv (khusus flag runtime Node). Kalau
  // ditaruh di execArgv, Node akan exit dengan "bad option: --cleartmp".
  const args = [join(__dirname, file), '--cleartmp', '--autoread', ...process.argv.slice(2)]

  setupMaster({
    exec: args[0],
    args: args.slice(1),
    execArgv: [
      '--expose-gc',
      '--max-old-space-size=512',
      '--optimize-for-size',
      '--gc-interval=100',
      '--env-file=' + join(process.cwd(), '.env')
    ]
  })

  const p = fork() // baru fork setelah install selesai
  currentProcess = p

  p.on('message', data => {
    switch (data) {
      case 'reset':
        intentionalReset = true
        p.process.kill()
        isRunning = false
        start(file)
        break
      case 'uptime':
        p.send(`${process.uptime()}`)
        break
    }
  })

  p.on('exit', (code, signal) => {
    isRunning = false
    console.error(chalk.red('# [ Exited ]') + ` with code: ${code}` + (signal? ` (signal: ${signal})` : ''))

    if (intentionalReset) {
      intentionalReset = false
      return
    }

    if (code === 1) {
      console.log(chalk.cyan('# [ Exited ] Memory exit detected, restart immediately...'))
      return start(file)
    }

    if (code === 0 &&!signal) return

    const now = Date.now()
    if (now - lastRestartTime > RESTART_WINDOW_MS) restartCount = 0
    restartCount++
    lastRestartTime = now

    if (restartCount > MAX_RESTART_COUNT) {
      const delay = Math.min(MAX_DELAY_MS, restartCount * 5000)
      console.error(chalk.yellow(`# [ Restart ] Too many restarts (${restartCount}x). Wait ${delay / 1000}s...`))
      setTimeout(() => start(file), delay)
      return
    }

    console.log(chalk.yellow(`# [ Restart ] Restart—${restartCount}... (Waiting for file changes or ${RESTART_DELAY_MS / 1000}s)`))

    let restarted = false
    const restartTimer = setTimeout(() => {
      if (restarted) return
      restarted = true
      unwatchFile(args[0])
      start(file)
    }, RESTART_DELAY_MS)

    watchFile(args[0], () => {
      if (restarted) return
      restarted = true
      clearTimeout(restartTimer)
      unwatchFile(args[0])
      start(file)
    })
  })
}

if (!Helper.opts['test']) {
  rl.on('line', line => {
    if (currentProcess) currentProcess.emit('message', line.trim())
  })
}

start('lib/main.js')