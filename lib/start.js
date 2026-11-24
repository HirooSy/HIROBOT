console.clear()

import { join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { spawnSync, fork as forkProcess } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const configFile = join(process.cwd(), 'config.json')
const exampleConfigFile = join(process.cwd(), 'config.example.json')

const stripJsonComments = text => text
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')
  .replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (match, string) => string ?? '')

function loadConfig() {
  if (!existsSync(configFile)) {
    console.error(existsSync(exampleConfigFile)
      ? 'Config is not set up yet. Copy config.example.json to config.json and fill in your values.'
      : 'config.json not found.')
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(configFile, 'utf8')))
  } catch (e) {
    console.error(`config.json is not valid JSON: ${e.message}`)
    if (!global.config) process.exit(1)
    return
  }
  global.config = parsed
  process.env.HIRO_CONFIG = JSON.stringify(parsed)
}

loadConfig()

if (!existsSync(join(process.cwd(), 'node_modules'))) {
  console.log('Installing modules. . .')
  const result = spawnSync('npm i --allow-git=all', {
    stdio: 'inherit',
    shell: true,
    cwd: process.cwd()
  })

  if (result.error || result.status !== 0) {
    console.error('Failed to install dependencies.' + (result.error ? ` ${result.error.message}` : ` npm exited with code ${result.status}`))
    process.exit(1)
  }

  console.clear()
}

await import('./utils/helper.js')

const { default: chalk } = await import('./utils/color.js')
const { setupMaster, fork } = await import('cluster')
const { watchFile, unwatchFile } = await import('fs')
const { createInterface } = await import('readline')
const { default: Helper } = await import('./utils/helper.js')

const require = createRequire(__dirname)
const rl = createInterface(process.stdin, process.stdout)

console.log(chalk.yellow(chalk.bold(`✦ ${global.config.bot.name}`)) + `\n─────────────────────────`)


const RESTART_WINDOW_MS = 5 * 60 * 1000
const MAX_RESTART_COUNT = 5
const RESTART_DELAY_MS = 3000
const MAX_DELAY_MS = 60_000

var isRunning = false
var intentionalReset = false
var restartCount = 0
var lastRestartTime = Date.now()

let currentProcess = null
let questionPending = false
let answerTarget = null

function relayQuestion(worker, text) {
  answerTarget = worker
  if (questionPending) return
  questionPending = true
  rl.question(text, answer => {
    questionPending = false
    const target = answerTarget
    answerTarget = null
    try {
      target?.send({ type: 'answer', answer })
    } catch {}
  })
}

async function start(file) {
  if (isRunning) return
  isRunning = true

  loadConfig()

  const args = [join(__dirname, file), '--cleartmp', ...process.argv.slice(2)]

  const execArgv = [
    '--expose-gc',
    '--max-old-space-size=512',
    '--optimize-for-size',
    '--max-semi-space-size=8',
  ]

  let p
  if (process.platform === 'win32') {
    p = forkProcess(args[0], args.slice(1), { execArgv, windowsHide: true })
  } else {
    setupMaster({
      exec: args[0],
      args: args.slice(1),
      execArgv
    })
    p = fork()
  }
  currentProcess = p

  p.on('message', data => {
    if (data?.type === 'question') return relayQuestion(p, data.text)
    switch (data) {
      case 'reset':
        intentionalReset = true
        p.once('exit', () => {
          isRunning = false
          start(file)
        })
        ;(p.process ?? p).kill()
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