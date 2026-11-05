const identRegex = /^[A-Za-z_$][\w$]*$/
const dropContextKeys = ['deviceListMetadata', 'messageSecret']
const mediaKeys = new Set(['jpegThumbnail', 'thumbnail'])
const base64TextRegex = /^[A-Za-z0-9+/]+={0,2}$/
const dataUriRegex = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+\/=]+)/g
const inlineMaxBytes = 2 * 1024
const maxChunkLength = 60000

const cache = (globalThis.__crmCache ||= new Map())
const nodesCache = (globalThis.__crmNodesCache ||= new Map())

const isLong = value =>
	value && typeof value === 'object' && typeof value.low === 'number' && typeof value.high === 'number'

const longToNum = long => {
	if (typeof long.toNumber === 'function') return long.toNumber()
	const big = (BigInt(long.high >>> 0) << 32n) | BigInt(long.low >>> 0)
	return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString()
}

const tsOf = child => {
	const timestamp = child.messageTimestamp
	if (!timestamp) return 0
	return isLong(timestamp) ? Number(longToNum(timestamp)) : Number(timestamp)
}

const isBase64Text = text => text.length >= 4 && text.length % 4 !== 1 && base64TextRegex.test(text)

const collectDataUris = (text, out) => {
	for (const match of text.matchAll(dataUriRegex)) {
		const base64 = match[2]
		if (base64.length * 0.75 <= inlineMaxBytes) continue
		out.set(base64, Buffer.from(base64, 'base64'))
	}
}

const fetchUriCode = (match, opts) =>
	`await _fetchUri(${JSON.stringify(opts.urls.get(match[2]))}, ${JSON.stringify(match[1])})`

const stringToCode = (text, opts) => {
	if (!opts.urls || !text.includes(';base64,')) return JSON.stringify(text)
	const matches = [...text.matchAll(dataUriRegex)].filter(match => opts.urls.has(match[2]))
	if (!matches.length) return JSON.stringify(text)
	const { code, last } = matches.reduce(
		(state, match) => ({
			code: `${state.code}${JSON.stringify(text.slice(state.last, match.index))} + ${fetchUriCode(match, opts)} + `,
			last: match.index + match[0].length
		}),
		{ code: '', last: 0 }
	)
	return `${code}${JSON.stringify(text.slice(last))}`
}

const decodeUnifiedResponse = encoded => {
	try {
		const json = Buffer.from(encoded, 'base64').toString('utf8')
		return JSON.parse(json)
	} catch {
		return null
	}
}

function collectBigBuffers(value, out, key = '') {
	if (value == null) return
	let buf
	if (value instanceof Uint8Array || Buffer.isBuffer(value)) buf = Buffer.from(value)
	else if (value.type === 'Buffer' && Array.isArray(value.data)) buf = Buffer.from(value.data)

	if (buf) {
		if (buf.length && (buf.length > inlineMaxBytes || mediaKeys.has(key))) out.set(buf.toString('base64'), buf)
		return
	}
	if (typeof value === 'string') {
		if (key === 'data') {
			const decoded = decodeUnifiedResponse(value)
			if (decoded && typeof decoded === 'object') {
				collectBigBuffers(decoded, out, key)
				return
			}
		}
		if (mediaKeys.has(key) && isBase64Text(value)) {
			const mediaBuf = Buffer.from(value, 'base64')
			out.set(mediaBuf.toString('base64'), mediaBuf)
			return
		}
		if (value.includes(';base64,')) collectDataUris(value, out)
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) collectBigBuffers(item, out, key)
		return
	}
	if (typeof value === 'object') {
		for (const [entryKey, entryValue] of Object.entries(value)) {
			if (typeof entryValue === 'function') continue
			if ((entryKey === 'messageContextInfo' || key === 'messageContextInfo') && dropContextKeys.includes(entryKey)) continue
			collectBigBuffers(entryValue, out, entryKey)
		}
	}
}

function guessExt(buf) {
	if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
	if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp'
	return 'bin'
}

export function toCode(value, opts = {}, indent = 0, key = '') {
	const pad = '\t'.repeat(indent + 1)
	const end = '\t'.repeat(indent)

	if (value === null || value === undefined) return undefined
	if (typeof value === 'bigint') return value.toString() + 'n'
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'string') {
		if (key === 'data') {
			const decoded = decodeUnifiedResponse(value)
			if (decoded && typeof decoded === 'object') {
				const code = toCode(decoded, opts, indent, key)
				if (code !== undefined) return code
			}
		}
		if (mediaKeys.has(key) && isBase64Text(value)) return bufferToCode(Buffer.from(value, 'base64'), opts, key)
		return stringToCode(value, opts)
	}

	if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
		if (!value.length) return undefined
		return bufferToCode(Buffer.from(value), opts, key)
	}
	if (value.type === 'Buffer' && Array.isArray(value.data)) {
		if (!value.data.length) return undefined
		return bufferToCode(Buffer.from(value.data), opts, key)
	}
	if (isLong(value)) return String(longToNum(value))

	if (Array.isArray(value)) {
		const items = value.map(item => toCode(item, opts, indent + 1, key)).filter(item => item !== undefined)
		if (!items.length) return undefined
		const body = items.reduce((text, item) => (text ? `${text},\n${pad}${item}` : `${pad}${item}`), '')
		return `[\n${body}\n${end}]`
	}

	if (typeof value === 'object') {
		const lines = Object.entries(value)
			.filter(([entryKey, entryValue]) => typeof entryValue !== 'function' && !((entryKey === 'messageContextInfo' || key === 'messageContextInfo') && dropContextKeys.includes(entryKey)))
			.map(([entryKey, entryValue]) => {
				const code = toCode(entryValue, opts, indent + 1, entryKey)
				return code === undefined ? undefined : `${pad}${identRegex.test(entryKey) ? entryKey : JSON.stringify(entryKey)}: ${code}`
			})
			.filter(line => line !== undefined)
		if (!lines.length) return '{}'
		const body = lines.reduce((text, line) => (text ? `${text},\n${line}` : line), '')
		return `{\n${body}\n${end}}`
	}
	return undefined
}

function bufferToCode(buf, opts, key) {
	if (opts.urls && (buf.length > inlineMaxBytes || mediaKeys.has(key))) {
		const url = opts.urls.get(buf.toString('base64'))
		if (url) return `await _fetchBuf(${JSON.stringify(url)})`
	}
	return `Buffer.from('${buf.toString('base64')}', 'base64')`
}

async function buildAlbumItem(conn, child, upload, index) {
	const type = child.message.imageMessage ? 'image' : child.message.videoMessage ? 'video' : null
	if (!type) return null
	const media = child.message[`${type}Message`]
	let buf
	try {
		buf = await conn.downloadM(media, type, {})
	} catch {
		return null
	}
	if (!Buffer.isBuffer(buf) || !buf.length) return null
	let url
	try {
		url = await upload(buf, `crm_${Date.now()}_${index}.${type === 'image' ? guessExt(buf) : 'mp4'}`)
	} catch {
		return null
	}
	if (!url) return null
	const fields = media.caption
		? `${type}: await _fetchBuf(${JSON.stringify(url)}), caption: ${JSON.stringify(media.caption)}`
		: `${type}: await _fetchBuf(${JSON.stringify(url)})`
	return `\t\t{ ${fields} }`
}

async function buildAlbumItems(conn, children, upload) {
	if (!upload || !children.length) return null
	const body = await children.reduce(async (previous, child, index) => {
		const text = await previous
		if (text === null) return null
		const item = await buildAlbumItem(conn, child, upload, index)
		if (item === null) return null
		return text ? `${text},\n${item}` : item
	}, Promise.resolve(''))
	return body || null
}

const contentType = msg =>
	Object.keys(msg || {}).find(entryKey => entryKey !== 'messageContextInfo' && msg[entryKey] != null)

const childCode = (childMessage, urls) => toCode(childMessage, { urls }, 0)
	.replace('"__CHAT__"', 'm.chat')
	.replace('"__ALBUM__"', '_album')

function assembleCode({ albumItems, childMessages, body, relayOpts, urls }) {
	if (albumItems) return `await conn.sendMessage(m.chat, {\n\talbum: [\n${albumItems}\n\t]\n}, {})`
	if (childMessages.length) {
		return childMessages.reduce(
			(text, childMessage) => `${text}\n\nawait conn.relayMessage(m.chat, ${childCode(childMessage, urls)}, {})`,
			`const _album = await conn.relayMessage(m.chat, ${body}, ${relayOpts})`
		)
	}
	return `await conn.relayMessage(m.chat, ${body}, ${relayOpts})`
}

let handler = async (ctx, { conn }) => {
	if (!ctx.quoted) throw 'Reply to the message whose code you want to get.\nExample: reply to a button message, then type *.crm*'

	const quotedId = ctx.quoted.id
	let message = cache.get(quotedId)
	const additionalNodes = nodesCache.get(quotedId)

	if (!message) {
		const stored = conn.loadMessage?.(ctx.quoted.sender, quotedId) || conn.loadMessage?.(quotedId)
		message = stored?.message
	}

	if (!message) {
		const raw = ctx.msg?.contextInfo?.quotedMessage
		const type = contentType(raw)
		if (type && !(type === 'conversation' && !raw.conversation)) message = raw
	}

	if (!message) throw 'Message content not found. This message was sent via relayMessage before crm was active, so resend it and try again.'

	const children = message.albumMessage
		? conn.loadAlbum(ctx.chat, quotedId)
			.filter(child => child.message)
			.sort((first, second) => tsOf(first) - tsOf(second))
		: []

	if (message.albumMessage && children.length) {
		const kinds = children.map(child => (child.message.videoMessage ? 'video' : 'image'))
		message = {
			...message,
			albumMessage: {
				...message.albumMessage,
				expectedImageCount: message.albumMessage.expectedImageCount || kinds.filter(kind => kind === 'image').length,
				expectedVideoCount: message.albumMessage.expectedVideoCount || kinds.filter(kind => kind === 'video').length
			}
		}
	}

	const upload = global.scraper?.upload?.default
	const albumItems = await buildAlbumItems(conn, children, upload)

	const childMessages = albumItems ? [] : children.map(child => ({
		...child.message,
		messageContextInfo: {
			messageAssociation: {
				parentMessageKey: { remoteJid: '__CHAT__', fromMe: true, id: '__ALBUM__' },
				associationType: 1
			}
		}
	}))

	const bigBuffers = new Map()
	collectBigBuffers(message, bigBuffers)
	for (const childMessage of childMessages) collectBigBuffers(childMessage, bigBuffers)
	collectBigBuffers(additionalNodes, bigBuffers)

	const urls = new Map()
	if (bigBuffers.size && upload) {
		await Promise.all(
			[...bigBuffers.entries()].map(async ([encoded, buf], index) => {
				try {
					const url = await upload(buf, `crm_${Date.now()}_${index}.${guessExt(buf)}`)
					if (url) urls.set(encoded, url)
				} catch {
					return
				}
			})
		)
	}

	const body = toCode(message, { urls }, 0)
	const nodesCode = additionalNodes?.length ? toCode(additionalNodes, { urls }, 1) : undefined
	const relayOpts = nodesCode ? `{\n\tadditionalNodes: ${nodesCode}\n}` : '{}'
	const code = assembleCode({ albumItems, childMessages, body, relayOpts, urls })

	const fetchBufHeader = code.includes('_fetchBuf(')
		? 'const _fetchBuf = async url => Buffer.from(await (await fetch(url)).arrayBuffer())\n'
		: ''
	const fetchUriHeader = code.includes('_fetchUri(')
		? "const _fetchUri = async (url, mime) => `data:${mime};base64,${Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64')}`\n"
		: ''
	const imports = `${fetchBufHeader}${fetchUriHeader}`
	const header = imports ? `${imports}\n` : ''
	const output = `${header}${code}\n`

	for (let offset = 0; offset < output.length; offset += maxChunkLength) {
		await conn.sendMessage(ctx.chat, { text: output.slice(offset, offset + maxChunkLength) }, { quoted: ctx })
	}
}

handler.help = ['crm']
handler.tags = ['tools']
handler.command = /^(crm|copyrelay)$/i
handler.ai = { risk: "low", description: "inspect message recipe, look up how to build that message" }

handler.platform = { whatsapp: true, discord: false }

export default handler
