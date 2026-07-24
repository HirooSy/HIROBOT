import fs from 'fs'
import syntaxError from 'syntax-error'
import path from 'path'
import util from 'util'

const _fs = fs.promises

let handler = async (m, { text, usedPrefix, command, __dirname }) => {
    if (!m.quoted) throw `reply text yang ingin dicheck`
    
            const error = syntaxError(m.quoted.text, text, {
                sourceType: 'module',
                allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true
            })
            if (error) throw error
            m.reply(`
0 ᴇʀʀᴏʀ ᴅᴇᴛᴇᴄᴛᴇᴅ`.trim())
            
}
handler.help = ['cekerror']
handler.tags = ['owner']
handler.command = /^(cekerror|error)$/i

handler.rowner = true

export default handler