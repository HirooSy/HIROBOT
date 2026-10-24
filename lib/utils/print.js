import chalk from './color.js'

export function sizeLabel(size) {
  if (!size || size <= 0) return chalk.gray('-')
  if (size < 1000) return chalk.gray(`${size}B`)
  if (size < 1000000) return chalk.gray(`${(size / 1000).toFixed(1)}KB`)
  return chalk.gray(`${(size / 1000000).toFixed(1)}MB`)
}

export function printEntry({ source, sender, type, size, message, error }) {
  const lines = [chalk.gray('-')]
  if (source) lines.push('• Source  : ' + source)
  lines.push(
    '• Sender  : ' + sender,
    '• Type    : ' + type,
    '• Size    : ' + size,
    '• Message : ' + (error ? chalk.red(message) : chalk.gray(message))
  )
  console.log(lines.join('\n'))
}

export function printDiscord({ user, guild, channel, kind = 'Text', isCommand = true, text = '', size = 0, error = false }) {
  if (global.opts?.noprint) return
  const name = user.globalName || user.username || ''
  const sender = `${chalk.gray('(' + name + ')')} ${chalk.gray(user.id)}`
  const place = guild
    ? `${guild.name || guild.id}${channel?.name ? ' › #' + channel.name : ''}`
    : 'Direct Message'
  const type = isCommand ? `${chalk.gray(kind)} ${chalk.greenBright('(Command)')}` : chalk.gray(kind)
  const raw = typeof text === 'string' && text ? text : '-'
  printEntry({
    source: chalk.gray('Discord › ' + place),
    sender,
    type,
    size: sizeLabel(size || (typeof text === 'string' ? text.length : 0)),
    message: raw.length > 60 ? raw.slice(0, 60) + '...' : raw,
    error
  })
}
