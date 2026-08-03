console.clear()

import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const envPath = join(process.cwd(), '.env')
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

if (!existsSync(join(process.cwd(), 'node_modules'))) {
  console.log('Installing modules. . .')
  const result = spawnSync('npm', ['i'], {
    stdio: 'ignore',
    shell: true,
    cwd: process.cwd()
  })

  if (result.error || result.status !== 0) {
    console.error('Failed')
    process.exit(1)
  }

  console.clear()
}

const { default: chalk } = await import('chalk')
const { setupMaster, fork } = await import('cluster')
const { watchFile, unwatchFile } = await import('fs')
const { createInterface } = await import('readline')
const { default: Helper } = await import('./helper.js')

const require = createRequire(__dirname)
const rl = createInterface(process.stdin, process.stdout)

console.log(chalk.yellow(chalk.bold(`✦ ${await process.env.BOT_NAME}`)) + `\n─────────────────────────`)


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
  const args = [join(__dirname, file), '--cleartmp', '--queue', '--autoread', ...process.argv.slice(2)]

  const execArgv = [
    '--expose-gc',
    '--max-old-space-size=250',
    '--optimize-for-size',
    '--gc-interval=100'
  ]

  if (existsSync(envPath)) {
    execArgv.push('--env-file=' + envPath)
  }

  setupMaster({
    exec: args[0],
    args: args.slice(1),
    execArgv
  })

  const p = fork()
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

start('main.js')