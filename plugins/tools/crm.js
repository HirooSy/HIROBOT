const IDENT = /^[A-Za-z_$][\w$]*$/
const DROP_CTX = ['deviceListMetadata', 'messageSecret']

const CACHE_MAX = 300
const cache = (globalThis.__crmCache ||= new Map())

// Buffers at or below this size stay inlined as Buffer.from('...', 'base64').
// Bigger ones get uploaded and referenced by URL instead, so the buffer's
// literal text never has to appear in the chat message at all.
const INLINE_MAX_BYTES = 2 * 1024

const clone = v => {
	try {
		return structuredClone(v)
	} catch {
		return v
	}
}

const hook = conn => {
	if (!conn || conn.relayMessage?.__crm) return
	const orig = conn.relayMessage
	const wrapped = async function (jid, message, opts = {}) {
		const id = await orig.call(this, jid, message, opts)
		const key = typeof id === 'string' ? id : opts?.messageId
		if (key) {
			cache.set(key, clone(message))
			if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
		}
		return id
	}
	wrapped.__crm = true
	conn.relayMessage = wrapped
}

const isLong = v =>
	v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number'

const longToNum = v => {
	if (typeof v.toNumber === 'function') return v.toNumber()
	const big = (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0)
	return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString()
}

const decodeUnifiedResponse = (b64) => {
	try {
		const json = Buffer.from(b64, 'base64').toString('utf8')
		return JSON.parse(json)
	} catch {
		return null
	}
}

// Pass 1: walk the message tree, find every buffer bigger than INLINE_MAX_BYTES,
// and collect them (deduped by content) so they can all be uploaded in parallel
// before we generate any code. Uploading one-by-one during the sync toCode walk
// isn't possible since upload() is async — hence this separate collection pass.
function collectBigBuffers(value, out, key = '') {
	if (value == null) return
	let buf
	if (value instanceof Uint8Array || Buffer.isBuffer(value)) buf = Buffer.from(value)
	else if (value.type === 'Buffer' && Array.isArray(value.data)) buf = Buffer.from(value.data)

	if (buf) {
		if (buf.length > INLINE_MAX_BYTES) out.set(buf.toString('base64'), buf)
		return
	}
	if (typeof value === 'string') {
		if (key === 'data') {
			const decoded = decodeUnifiedResponse(value)
			if (decoded && typeof decoded === 'object') collectBigBuffers(decoded, out, key)
		}
		return
	}
	if (Array.isArray(value)) {
		for (const v of value) collectBigBuffers(v, out, key)
		return
	}
	if (typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			if (typeof v === 'function') continue
			if ((k === 'messageContextInfo' || key === 'messageContextInfo') && DROP_CTX.includes(k)) continue
			collectBigBuffers(v, out, k)
		}
	}
}

// mime guess just for a sane filename/extension on the uploaded file — doesn't
// affect correctness, upload() accepts any buffer regardless of what's guessed.
function guessExt(buf) {
	if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
	if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'webp'
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
		return JSON.stringify(value)
	}

	if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
		if (!value.length) return undefined
		return bufferToCode(Buffer.from(value), opts)
	}
	if (value.type === 'Buffer' && Array.isArray(value.data)) {
		if (!value.data.length) return undefined
		return bufferToCode(Buffer.from(value.data), opts)
	}
	if (isLong(value)) return String(longToNum(value))

	if (Array.isArray(value)) {
		const items = value.map(v => toCode(v, opts, indent + 1, key)).filter(v => v !== undefined)
		if (!items.length) return undefined
		return `[\n${items.map(v => pad + v).join(',\n')}\n${end}]`
	}

	if (typeof value === 'object') {
		const lines = []
		for (const [k, v] of Object.entries(value)) {
			if (typeof v === 'function') continue
			if (k === 'messageContextInfo' || key === 'messageContextInfo') {
				if (DROP_CTX.includes(k)) continue
			}
			const code = toCode(v, opts, indent + 1, k)
			if (code === undefined) continue
			lines.push(`${pad}${IDENT.test(k) ? k : JSON.stringify(k)}: ${code}`)
		}
		if (!lines.length) return '{}'
		return `{\n${lines.join(',\n')}\n${end}}`
	}
	return undefined
}

function bufferToCode(buf, opts) {
	if (buf.length > INLINE_MAX_BYTES && opts.urls) {
		const url = opts.urls.get(buf.toString('base64'))
		if (url) return `await _fetchBuf('${url}')`
	}
	return `Buffer.from('${buf.toString('base64')}', 'base64')`
}

const contentType = msg =>
	Object.keys(msg || {}).find(k => k !== 'messageContextInfo' && msg[k] != null)

let handler = async (m, { conn }) => {
	if (!m.quoted) throw 'Reply pesan yang mau diambil kodenya.\nContoh: reply pesan button lalu ketik *.crm*'

	const qid = m.quoted.id
	let message = cache.get(qid)

	if (!message) {
		const stored = conn.loadMessage?.(m.quoted.sender, qid) || conn.loadMessage?.(qid)
		message = stored?.message
	}

	if (!message) {
		const raw = m.msg?.contextInfo?.quotedMessage
		const t = contentType(raw)
		if (t && !(t === 'conversation' && !raw.conversation)) message = raw
	}

	if (!message) throw 'Isi pesan tidak ketemu. Pesan ini dikirim lewat relayMessage sebelum crm aktif, kirim ulang pesannya lalu coba lagi.'

	// Pass 1: find big buffers, upload them all in parallel.
	const bigBuffers = new Map() // base64 -> Buffer
	collectBigBuffers(message, bigBuffers)

	const urls = new Map() // base64 -> url
	const upload = global.scraper?.upload?.default
	if (bigBuffers.size && upload) {
		await Promise.all(
			[...bigBuffers.entries()].map(async ([b64, buf]) => {
				try {
					const url = await upload(buf, `crm_${Date.now()}.${guessExt(buf)}`)
					if (url) urls.set(b64, url)
				} catch (e) {
					console.error('[crm] upload failed, falling back to inline base64:', e.message)
				}
			})
		)
	}

	// Pass 2: generate the code, using URL fetch placeholders wherever an upload succeeded.
	const body = toCode(message, { urls }, 0)
	const code = `await conn.relayMessage(m.chat, ${body}, {})`

	const needsFetch = code.includes('_fetchBuf(')
	const header = needsFetch
		? `const _fetchBuf = async url => Buffer.from(await (await fetch(url)).arrayBuffer())\n\n`
		: ''

	const out = header + code + '\n'
	const MAX = 60000
	for (let i = 0; i < out.length; i += MAX) {
		await conn.sendMessage(m.chat, { text: out.slice(i, i + MAX) }, { quoted: m })
	}
}

handler.all = async function () {
	hook(this)
}

handler.help = ['crm']
handler.tags = ['tools']
handler.command = /^(crm|copyrelay)$/i
handler.ai = { risk: "low", description: "inspect message recipe, look up how to build that message" }

export default handler