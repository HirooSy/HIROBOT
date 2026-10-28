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
