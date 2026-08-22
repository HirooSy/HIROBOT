import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import chalk from '../../utils/color.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VOIP_ENTRY = path.join(__dirname, 'index.js')
const require = createRequire(import.meta.url)

let cached = null
let loading = null

function installIfMissing(folderName, installSpec, projectRoot) {
  const pkgDir = path.join(projectRoot, 'node_modules', folderName)
  if (fs.existsSync(pkgDir)) return

  const { execSync } = require('child_process')
  const lockFile = path.join(projectRoot, `.${folderName.replace('/', '_')}.install.lock`)
  const maxWaitMs = 60_000
  const start = Date.now()

  while (fs.existsSync(lockFile)) {
    if (fs.existsSync(pkgDir)) return
    if (Date.now() - start > maxWaitMs) break
    execSync('sleep 0.5')
  }
  if (fs.existsSync(pkgDir)) return

  try {
    fs.writeFileSync(lockFile, String(process.pid))
    if (fs.existsSync(pkgDir)) return
    console.log(chalk.red('[ VOIP ]') + chalk.gray(` ${folderName} not installed, installing (${installSpec})...`))
    execSync(`npm i ${installSpec} --no-save`, { cwd: projectRoot, stdio: 'ignore' })
  } finally {
    try { fs.unlinkSync(lockFile) } catch {}
  }
}

function findProjectRoot(startDir) {
  // Walk upward from startDir looking for the nearest ancestor that has a
  // node_modules folder — this is robust to voip.js living at any nesting
  // depth (lib/voip/, lib/package/voip/, etc), unlike a fixed count of
  // path.dirname() calls which silently breaks (points at the wrong
  // directory, with no error) the moment the folder gets moved deeper or
  // shallower.
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root without finding it
    dir = parent
  }
  // Fallback: previous fixed-depth behavior, so this never throws outright
  // if node_modules genuinely isn't there yet (e.g. very first install)
  return path.dirname(path.dirname(startDir))
}

async function loadVoip() {
  if (cached) return cached
  if (loading) return loading

  loading = (async () => {
    const projectRoot = findProjectRoot(__dirname)

    try {
      installIfMissing('wrtc', 'wrtc@npm:@roamhq/wrtc', projectRoot)
    } catch (e) {
      console.error(chalk.red('[ VOIP ]') + chalk.gray(` Failed to auto-install 'caller' (@roamhq/wrtc): ${e?.message || e}`))
      throw e
    }

    const mod = await import(`file://${VOIP_ENTRY}`)
    cached = { VoipClient: mod.VoipClient, CallState: mod.CallState }
    return cached
  })()

  return loading
}

export { loadVoip }
export default loadVoip
