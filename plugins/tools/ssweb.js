
let handler = async (m, { conn, text, command, usedPrefix, platform }) => {
  if (!text) return m.reply(`- Input url.\n${usedPrefix + command} <url> -<desktop/phone/tablet>`)
  var type_ss = 'desktop'
  if (/phone/.test(text)) { type_ss = 'phone' }
  if (/tablet/.test(text)) { type_ss = 'tablet' }
  m.react("🔎")
  var result = await global.scraper.ssweb.ssweb(text.split(' ')[0], type_ss)
  try {
    const shot = result.result ? result.result : result
    if (platform === 'discord') await conn.discord(m.chat, { image: shot, fileName: 'screenshot.png' })
    else await conn.sendFile(m.chat, shot, '',null, m)
    m.react("✅")
  } catch(e) { m.error = e; throw e }
}
handler.help = [
    ...(['ssweb <url>']),
    { command: 'ssweb', name: 'text', description: 'Website URL, add -phone or -tablet for another view', type: 'string', required: true }
]
handler.tags = ['tools']
handler.command = ['ssweb']
handler.description = 'Take a screenshot of a website'
handler.registered = true
handler.platform = { whatsapp: true, discord: true }

export default handler
