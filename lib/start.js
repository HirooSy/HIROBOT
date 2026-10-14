console.clear()

import { join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

function parseEnv(content) {
  const env = {}
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(lines[i])
    if (!match) continue
    let value = match[2].trim()
    const quote = value[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      let body = value.slice(1)
      while (!body.includes(quote) && i + 1 < lines.length) body += '\n' + lines[++i]
      const end = body.indexOf(quote)
      value = end === -1 ? body : body.slice(0, end)
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    env[match[1]] = value
  }
  return env
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const envPath = join(process.cwd(), '.env')
const osEnv = { ...process.env }
let envFileKeys = []

function syncEnvFromFile() {
  let fileEnv
  try {
    fileEnv = parseEnv(readFileSync(envPath, 'utf8'))
  } catch {
    return
  }
  const keys = new Set([...envFileKeys, ...Object.keys(fileEnv)])
  for (const key of keys) {
    const value = Object.hasOwn(osEnv, key) ? osEnv[key] : fileEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envFileKeys = Object.keys(fileEnv)
}

syncEnvFromFile()

if (!existsSync(join(process.cwd(), 'node_modules'))) {
  console.log('Installing modules. . .')
  const result = spawnSync('npm', ['i', '--allow-git=all'], {
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

await import('./config.js')

const { default: chalk } = await import('./utils/color.js')
const { setupMaster, fork } = await import('cluster')
const { watchFile, unwatchFile } = await import('fs')
const { createInterface } = await import('readline')
const { default: Helper } = await import('./utils/helper.js')

const require = createRequire(__dirname)
const rl = createInterface(process.stdin, process.stdout)

console.log(chalk.yellow(chalk.bold(`✦ ${await global.settings.botname}`)) + `\n─────────────────────────`)


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

  syncEnvFromFile()

  const args = [join(__dirname, file), '--cleartmp', ...process.argv.slice(2)]

  const execArgv = [
    '--expose-gc',
    '--max-old-space-size=512',
    '--optimize-for-size',
    '--max-semi-space-size=8',
  ]

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
        p.once('exit', () => {
          isRunning = false
          start(file)
        })
        p.process.kill()
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