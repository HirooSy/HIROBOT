import { plugins } from "../../lib/plugins.js"

let handler = async (m, { conn }) => {
  let stats = Object.entries(db.data.stats).map(([key, val]) => {
    let name = Array.isArray(plugins[key]?.help) ? plugins[key]?.help?.join(' & ') : plugins[key]?.help || key 
    if (/exec/.test(name)) return
    return { name, ...val }
  })
  stats = stats.sort((a, b) => b.total - a.total)
  let txt = stats.slice(0, 10).map(({ name, total, last }, idx) => {
    return `*| ${idx + 1}」 ${name}*\n • Hit : *${total}*\n • Last : ${getTime(last)}\n`
  }).join`\n`
  m.reply(txt)
}
handler.help = ['dashboard']
handler.tags = ['info']
handler.command = /^(db|dashboard)$/i
handler.ai = { risk: 'low', isTool: true, description: "Commands usage statistics" }

export default handler 
	
function parseMs(ms) {
  if (typeof ms !== 'number') throw 'Parameter must be filled with number'
  return {
    days: Math.trunc(ms / 86400000),       
    hours: Math.trunc(ms / 3600000) % 24,
    minutes: Math.trunc(ms / 60000) % 60,
    seconds: Math.trunc(ms / 1000) % 60,
    milliseconds: Math.trunc(ms) % 1000,
    microseconds: Math.trunc(ms * 1000) % 1000,
    nanoseconds: Math.trunc(ms * 1e6) % 1000
  }
           }
 function getTime(ms) {
  
          let now = parseMs(+new Date() - ms)
 
          
          if (now.days) { return `${now.days} days ago`
          } else if (now.hours) { return `${now.hours} hours ago`
          } else if (now.minutes) { return `${now.minutes} minutes ago`
  
          } else return `a few seconds ago`

}