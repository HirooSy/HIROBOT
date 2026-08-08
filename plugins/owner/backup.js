import { ZipFile as JSZip } from '../../lib/converter.js'
import { join } from 'path'
import { statSync, readFileSync, readdirSync } from 'fs'

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
  const cwd = process.cwd()
  const tmpPath = join(cwd, 'data/tmp')

  const zipAll = new JSZip()

  const excludePaths = [
    tmpPath,
    join(cwd, 'node_modules'),
    join(cwd, 'package-lock.json'),
    join(cwd, 'data/store.json'),
    join(cwd, 'data/backups'),
    join(cwd, 'data/reminder.json'),
  ]

  await addFolderRecursively(zipAll, cwd, cwd, excludePaths)

  const allBuffer = await zipAll.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await conn.sendMessage(m.chat, { document: allBuffer, mimetype: 'application/zip', fileName: `backup_${Date.now()}.zip` }, { quoted: m })
}

handler.command = /^(backup)$/i
handler.tags = ['owner']
handler.help = ['backup']
handler.rowner = true
handler.private = true
handler.ai = { risk: 'low', description: 'backup project' }

export default handler