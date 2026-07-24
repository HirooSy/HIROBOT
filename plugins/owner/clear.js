import fs from "fs"
import { tmpdir } from 'os'
import path, { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync
} from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

let handler = async (m, { conn, text, args, command, usedPrefix}) => {
	
//===========[ REQUIREMENT ]==============
  let type = (args[0] || '').toLowerCase()
  let _type = (args[0] || '').toLowerCase()
  var teks =`*| LIST*
- store [msg]
- tmp
- session [sesi]
- chat`
  if (!type) throw teks

//====================[ CASE ]================
  
        switch (type) {
case 'store':
case 'msg':
     let storePath = "./data/store.json"
     if (existsSync(storePath)) {
         unlinkSync(storePath)
     }
     let abc = `{\n"chats": {},\n"messages": {}\n}`
     writeFileSync(storePath, abc)
     conn.react(m.chat, "✅", { remoteJid: m.key.remoteJid, id: m.key.id, fromMe: false, participant: m.key.participant})

      break
      
case 'tmp':
       const tmp = [tmpdir() || join(process.cwd(), process.env.TMP)]
       const filename = []
             tmp.forEach(dir => {
                if (existsSync(dir)) {
                    readdirSync(dir).forEach(file => filename.push(join(dir, file)))
                }
             })
             filename.forEach(file => {
                try {
                    const stats = statSync(file)
                    if (stats.isFile()) {
                        unlinkSync(file)
                    } else if (stats.isDirectory()) {
                        // Skip directories to avoid EISDIR error
                    }
                } catch (e) {
                    console.error("Gagal hapus file:", file, e)
                }
             })
       conn.react(m.chat, "✅", { remoteJid: m.key.remoteJid, id: m.key.id, fromMe: false, participant: m.key.participant})
       break
       
case 'sesi':
case 'session':
       const sessionsRoot = join(process.cwd(), 'data/sessions')
       const sessionDirs = []

       // Main bot session
       const mainPath = join(sessionsRoot, 'main')
       if (existsSync(mainPath)) sessionDirs.push(mainPath)

       // All jadibot (sub-bot) sessions
       const jadibotRoot = join(sessionsRoot, 'jadibot')
       if (existsSync(jadibotRoot)) {
           readdirSync(jadibotRoot).forEach(folder => {
               const fullPath = join(jadibotRoot, folder)
               if (statSync(fullPath).isDirectory()) sessionDirs.push(fullPath)
           })
       }

       if (!sessionDirs.length) {
           m.reply("Tidak ada folder session yang ditemukan!")
           break
       }

       let cleared = 0
       for (const dir of sessionDirs) {
           const files = readdirSync(dir)
           for (const file of files) {
               if (file !== 'creds.json') {
                   try {
                       rmSync(join(dir, file), { recursive: true, force: true })
                       cleared++
                   } catch (e) {
                       console.error("Gagal hapus:", join(dir, file), e)
                   }
               }
           }
       }

       await conn.reply(m.chat, `🧹 Cache session dibersihkan dari ${sessionDirs.length} sesi (${cleared} item dihapus). Semua creds.json tetap disimpan.`, m)
      break

case 'chat':
     try {
     await conn.chatModify({ delete: true, lastMessages: [{key: m.key, messageTimestamp: m.messageTimestamp}] }, m.chat).forEach(_=>
          m.reply("Berhasil menghapus chat ini!"))
         } catch (e) {
    m.reply("Gagal menghapus chat!") 
           throw e
   }
    break
}
        

}

handler.help = ['clear <type>']
handler.tags = ['host','owner']
handler.command = /^(clear)$/i

handler.rowner = true

export default handler
