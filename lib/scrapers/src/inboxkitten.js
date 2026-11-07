const baseUrl = 'https://inboxkitten.com'
const apiBase = `${baseUrl}/api/v1/mail`
const domain = 'inboxkitten.com'

const getHeaders = (recipient = null) => {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': recipient
      ? `${baseUrl}/inbox/${encodeURIComponent(recipient.replace(/@inboxkitten\.com$/i, ''))}`
      : baseUrl
  }
}

export async function generateEmail(customUser = null) {
  const user = (customUser || `user_${Math.random().toString(36).substring(2, 8)}`).toLowerCase()

  return {
    email: `${user}@${domain}`,
    inboxUrl: `${baseUrl}/inbox/${user}`
  }
}

export async function generateBulkEmails(count = 5) {
  const emails = []
  for (let i = 0; i < count; i++) {
    const res = await generateEmail()
    emails.push(res.email)
  }
  return emails
}

export async function getDomains() {
  return [domain]
}

export async function getInbox(email, limit = 20) {
  const username = email.split('@')[0].trim().toLowerCase()
  const res = await fetch(`${apiBase}/list?recipient=${encodeURIComponent(username)}`, {
    method: 'GET',
    headers: getHeaders(username)
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch inbox (${res.status}): ${res.statusText}`)
  }

  const data = await res.json()
  if (!Array.isArray(data)) return []

  return data
    .slice(0, limit)
    .map(m => {
      const region = m.storage?.region || 'us-east4'
      const id = `${region}::${m.storage?.key}`

      let time = ''
      if (m.timestamp) {
        time = new Date(m.timestamp * 1000).toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit'
        })
      }

      return {
        id,
        from: m.message?.headers?.from || m.envelope?.sender || 'Unknown',
        subject: m.message?.headers?.subject || '(No Subject)',
        time
      }
    })
}

function decodeEntity(match, entity) {
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  }
  return new Map([
    ['nbsp', ' '],
    ['amp', '&'],
    ['quot', '"'],
    ['apos', "'"],
    ['lt', '<'],
    ['gt', '>'],
    ['copy', '©'],
    ['reg', '®'],
    ['trade', '™'],
    ['hellip', '…'],
    ['mdash', '—'],
    ['ndash', '–'],
    ['lsquo', '‘'],
    ['rsquo', '’'],
    ['ldquo', '“'],
    ['rdquo', '”'],
    ['bull', '•'],
    ['middot', '·'],
    ['euro', '€'],
    ['pound', '£'],
    ['yen', '¥'],
    ['cent', '¢'],
    ['deg', '°'],
    ['times', '×'],
    ['laquo', '«'],
    ['raquo', '»']
  ]).get(entity.toLowerCase()) ?? match
}

export async function readMessage(param1, param2) {
  let messageId = ''

  if (param2) {
    messageId = param1.includes('@') ? param2 : param1
  } else {
    messageId = param1
  }

  let region = 'us-east4'
  let key = messageId

  if (messageId.includes('::')) {
    const parts = messageId.split('::')
    region = parts[0]
    key = parts[1]
  }

  const url = `${apiBase}/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders()
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch message (${res.status}): ${res.statusText}`)
  }

  const rawHtml = await res.text()

  const otpTagMatch = rawHtml.match(/>\s*(\d{4,8})\s*</)
  const otpContextMatch = rawHtml.match(/(?:code|kode|otp|token|pin|verification)[\s\S]{0,35}?(\b\d{4,8}\b)/i)
  const otp = otpTagMatch ? otpTagMatch[1] : (otpContextMatch ? otpContextMatch[1] : null)

  const linkMatch = rawHtml.match(/href="(https?:\/\/[^"]*(?:verify|confirm|activation|token|signature|action)[^"]*)"/i)
    || rawHtml.match(/href="([^"]+)"[^>]*>(?:Подтвердить|Confirm|Verify|Activate|Verifikasi)/i)
  const link = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : null

  const links = [...new Set((rawHtml.match(/https?:\/\/[^\s"'<>]+/gi) || [])
    .map(url => url.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, decodeEntity))
    .map(url => url.replace(/[.,;:!?&]+$/, ''))
    .map(url => (url.includes('(') ? url : url.replace(/\)+$/, '')))
  )]

  const cleanText = rawHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim()

  return {
    id: messageId,
    from: 'Inbox Sender',
    subject: 'Email Message',
    otp,
    link,
    links,
    text: cleanText,
    content: rawHtml,
    rawHtml
  }
}

export const inboxKitten = {
  generateEmail,
  generateBulkEmails,
  getDomains,
  getInbox,
  messageList: getInbox,
  readMessage
}

export default inboxKitten
