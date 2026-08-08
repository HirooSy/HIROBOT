import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import chalk from '../color.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VOIP_DIST = path.join(__dirname, 'dist', 'index.mjs')
const require = createRequire(import.meta.url)

let cached = null
let loading = null

function installIfMissing(pkgName, projectRoot) {
  const pkgDir = path.join(projectRoot, 'node_modules', pkgName)
  if (fs.existsSync(pkgDir)) return
  const { execSync } = require('child_process')
  console.log(chalk.red('[ VOIP ]') + chalk.gray(` ${pkgName} not installed, installing...`))
  execSync(`npm i ${pkgName} --no-save`, { cwd: projectRoot, stdio: 'ignore' })
}

/**
 * Lazy-loads baileys-caller's VoipClient + CallState.
 * Auto-installs the native @roamhq/wrtc peer dependency on first use.
 */
async function loadVoip() {
  if (cached) return cached
  if (loading) return loading

  loading = (async () => {
    const projectRoot = path.dirname(path.dirname(__dirname))

    try {
      installIfMissing('@roamhq/wrtc', projectRoot)
    } catch (e) {
      console.error(chalk.red('[ VOIP ]') + chalk.gray(` Failed to auto-install @roamhq/wrtc: ${e?.message || e}`))
      throw e
    }

    const mod = await import(`file://${VOIP_DIST}`)
    cached = { VoipClient: mod.VoipClient, CallState: mod.CallState }
    return cached
  })()

  return loading
}

export { loadVoip }
export default loadVoip
