import { ZipFile as JSZip } from '../../lib/utils/converter.js'
import { join } from 'path'
import { statSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function dirSize(dir) {
  let total = 0
  for (const item of readdirSync(dir)) {
    const fullPath = join(dir, item)
    const stat = statSync(fullPath)
    total += stat.isDirectory() ? dirSize(fullPath) : stat.size
  }
  return total
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes.toFixed(i ? 2 : 0)} ${units[i]}`
}

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 })
}

async function cleanupGit(cwd) {
  const gitDir = join(cwd, '.git')
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return null

  const before = dirSize(gitDir)

  try {
    await git(cwd, ['reflog', 'expire', '--expire-unreachable=now', '--all'])
    await git(cwd, ['gc', '--aggressive', '--prune=now'])
  } catch (e) {
    console.error('[backup] git cleanup failed:', e.message)
  }

  const hooksDir = join(gitDir, 'hooks')
  if (existsSync(hooksDir)) {
    for (const file of readdirSync(hooksDir)) {
      if (file.endsWith('.sample')) rmSync(join(hooksDir, file), { force: true })
    }
  }

  return { before, after: dirSize(gitDir) }
}

async function addFolderRecursively(zip, folderPath, cwd, excludePaths) {
  const items = readdirSync(folderPath)

  for (const item of items) {
    const fullPath = join(folderPath, item)
    if (excludePaths.includes(fullPath)) continue

    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      await addFolderRecursively(zip, fullPath, cwd, excludePaths)
    } else {
      const zipPath = fullPath.replace(cwd + '/', '')
      zip.file(zipPath, readFileSync(fullPath))
    }
  }
}

let handler = async (m, { conn }) => {
  m.react('⏳')

  const cwd = process.cwd()
  const gitInfo = await cleanupGit(cwd)

  const zipAll = new JSZip()

  const excludePaths = [
    join(cwd, 'node_modules'),
    join(cwd, 'package-lock.json'),
    join(cwd, 'yarn.lock'),
    join(cwd, 'data/store.json'),
    join(cwd, 'data/ai/backups'),
    join(cwd, 'data/reminder.json'),
    join(cwd, 'data/tunnel'),
    join(cwd, 'data/tmp'),
    join(cwd, '.cache'),
    join(cwd, '.npm'),
    join(cwd, '.agents'),
    join(cwd, '.config'),
    join(cwd, 'data/sessions/store.db'),
  ]

  await addFolderRecursively(zipAll, cwd, cwd, excludePaths)

  const allBuffer = await zipAll.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })

  const caption = gitInfo
    ? `- .git: ${formatSize(gitInfo.before)} → ${formatSize(gitInfo.after)}\n- Zip: ${formatSize(allBuffer.length)}`
    : `- Zip: ${formatSize(allBuffer.length)}`

  await conn.sendMessage(m.chat, {
    document: allBuffer,
    mimetype: 'application/zip',
    fileName: `backup_${Date.now()}.zip`,
    caption
  }, { quoted: m })

  m.react('✅')
}

handler.command = /^(backup)$/i
handler.tags = ['owner']
handler.help = ['backup']
handler.rowner = true
handler.private = true
handler.ai = { risk: 'low', description: 'backup project' }

export default handler