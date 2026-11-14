export function waToDiscord(input) {
  let out = String(input ?? '').replace(/\u200e{8,}/g, '')
  const kept = []
  out = out.replace(/```[\s\S]*?```|`[^`\n]+`/g, block => {
    kept.push(block)
    return `\u0000${kept.length - 1}\u0000`
  })
  out = out.replace(/(^|[\s([{>])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s)\]}.,!?:;])/g, '$1**$2**')
  out = out.replace(/(^|[\s([{>])~(?!\s)([^~\n]+?)(?<!\s)~(?=$|[\s)\]}.,!?:;])/g, '$1~~$2~~')
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
}

export function chunkText(text, size = 1900) {
  const chunks = []
  let rest = String(text)
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size)
    if (cut < size * 0.5) cut = size
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length) chunks.push(rest)
  return chunks
}

export function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function snowflakeOf(input) {
  if (input && typeof input === 'object') return input.id ? String(input.id) : null
  const text = String(input ?? '').trim()
  return /^<(?:@[!&]?|#)(\d{15,22})>$/.exec(text)?.[1] || (/^\d{15,22}$/.test(text) ? text : null)
}

export function parseEmoji(input) {
  const text = String(input ?? '').trim()
  const custom = /^<a?:(\w+):(\d{15,22})>$/.exec(text)
  if (custom) return { key: `${custom[1]}:${custom[2]}`, path: `${custom[1]}:${custom[2]}`, display: text }
  if (!text || /\s/.test(text) || text.length > 64) return null
  return { key: text, path: text, display: text }
}

export function parseMessageRef(input, channelId) {
  const text = String(input ?? '').trim()
  const link = /discord(?:app)?\.com\/channels\/(\d{15,22}|@me)\/(\d{15,22})\/(\d{15,22})/.exec(text)
  if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] }
  if (/^\d{15,22}$/.test(text)) return { guildId: null, channelId: String(channelId), messageId: text }
  return null
}

export const defaultWelcome = 'Welcome {user} to {server}! You are member #{count}.'

export function formatWelcome(template, member) {
  const guild = member.guild
  return String(template || defaultWelcome)
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{username\}/g, member.user.globalName || member.user.username)
    .replace(/\{server\}/g, guild.name)
    .replace(/\{count\}/g, String(guild.memberCount ?? ''))
    .slice(0, 1000)
}
