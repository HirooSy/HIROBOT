import AdmZip from "adm-zip"
import { join } from 'path'
import {
  statSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs'

let handler = async (m, { conn, args, command }) => {
  let type = (args[0] || '').toLowerCase()
  const cwd = process.cwd()
  const tmpPath = process.env.TMP ? join(cwd, process.env.TMP) : join(cwd, 'tmp')
  const sessionPath = join(cwd, "data/sessions")
  
  try {
    if (/(backup)/i.test(command)) {
      switch (type) {
        case 'database':
        case 'db':
          try {
            await conn.sendFile(m.chat, readFileSync('./data/database.json'), 'database.json', '', null, null, { mimetype: 'application/json', quoted: m })
          } catch(e) {
            m.reply("Database not found or failed to send")
          }
          break
          
        case 'plugins':
          m.reply('Compressing plugins...')
          let zipPlugins = new AdmZip()
          zipPlugins.addLocalFolder("./plugins")
          let pluginsBuffer = zipPlugins.toBuffer()
          await conn.sendMessage(m.chat, { document: pluginsBuffer, mimetype: 'application/zip', fileName: 'plugins.zip' }, { quoted: m })
          break
          
        case 'all':
        case 'full':
        case 'script':
        case 'sc':
          m.reply('Compressing all files...')
          let zipAll = new AdmZip()
          
          const excludePaths = [
            tmpPath,
            join(cwd, 'node_modules'),
            join(cwd, 'package-lock.json'),
            join(cwd, 'data/store.json'),
            join(cwd, 'data/backups'),
            join(cwd, 'data/reminder.json')
          ]
          
          function addFolderRecursively(zip, folderPath) {
            const items = readdirSync(folderPath)
            
            for (const item of items) {
              const fullPath = join(folderPath, item)
              if (excludePaths.includes(fullPath)) continue
              
              const stat = statSync(fullPath)
              
              if (stat.isDirectory()) {
                addFolderRecursively(zip, fullPath)
              } else {
                const zipPath = fullPath.replace(cwd + '/', '')
                zip.addFile(zipPath, readFileSync(fullPath))
              }
            }
          }
          
          addFolderRecursively(zipAll, cwd)
          
          let allBuffer = zipAll.toBuffer()
          await conn.sendMessage(m.chat, { document: allBuffer, mimetype: 'application/zip', fileName: `backup_${Date.now()}.zip` }, { quoted: m })
          break
          
        case 'session':
        case 'sesi':
          if (!existsSync(sessionPath)) {
            m.reply("Sessions folder not found")
            return
          }
          m.reply('Compressing sessions...')
          let zipSessions = new AdmZip()
          zipSessions.addLocalFolder(sessionPath)
          let sessionsBuffer = zipSessions.toBuffer()
          await conn.sendMessage(m.chat, { document: sessionsBuffer, mimetype: 'application/zip', fileName: 'sessions.zip' }, { quoted: m })
          break
          
        default:
          return m.reply(`Available backup types:\n• database/db\n• plugins\n• session/sesi\n• all/script/sc\n\nExample: .backup all`)
      }
    }
  } catch (err) {
    m.reply("Error: " + err.stack)
  }
}

handler.help = ['backup <type>']
handler.tags = ['owner']
handler.command = /^(backup)$/i
handler.rowner = true
handler.private = true

export default handler
