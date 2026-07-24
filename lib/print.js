import chalk from 'chalk'
import { watchFile } from 'fs'
import Helper from './helper.js'

export default async function (m, conn = { user: {} }) {
  try {
    let name = await conn.getName(m.sender).catch?.(() => '') || ''
    let senderLabel = name
      ? `${chalk.gray('(' + name + ')')} ${chalk.green(m.sender)}`
      : chalk.green(m.sender || 'unknown')

    let mtype = m.mtype
      ? m.mtype.replace(/message$/i, '').replace('audio', m.msg?.ptt ? 'PTT' : 'Audio').replace(/^./, v => v.toUpperCase())
      : '-'
    let typeLabel = m.isCommand
      ? `${chalk.gray(mtype)} ${chalk.greenBright('(Command)')}`
      : chalk.gray(mtype)

    let filesize = m.msg?.fileLength?.low || m.msg?.fileLength || m.text?.length || 0
    let sizeLabel = filesize <= 0 ? chalk.gray('-')
      : filesize < 1000 ? chalk.gray(`${filesize}B`)
      : filesize < 1000000 ? chalk.gray(`${(filesize / 1000).toFixed(1)}KB`)
      : chalk.gray(`${(filesize / 1000000).toFixed(1)}MB`)

    let raw = typeof m.text === 'string' && m.text ? m.text : '-'
    let msgText = raw.length > 60 ? raw.slice(0, 60) + '...' : raw
    let msgLabel = m.error ? chalk.red(msgText) : chalk.gray(msgText)

    console.log([
      chalk.gray('-'),
      chalk.cyan('• Sender:')  + '  ' + senderLabel,
      chalk.cyan('• Type:')    + '    ' + typeLabel,
      chalk.cyan('• Size:')    + '    ' + sizeLabel,
      chalk.cyan('• Message:') + ' ' + msgLabel,
      chalk.gray('-'),
    ].join('\n'))
  } catch (e) {
    console.error('print.js >', e.message)
  }
}

let file = Helper.__filename(import.meta.url)
watchFile(file, () => {
  console.log(chalk.redBright("Update 'lib/print.js'"))
})