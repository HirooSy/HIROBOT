const API = 'https://discord.com/api/v10'
const USER_AGENT = 'DiscordBot (hiro, 1.0)'
const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 30000
const RETRYABLE_METHODS = ['GET', 'PUT', 'DELETE', 'PATCH']

export class DiscordAPIError extends Error {
  constructor(status, body, method, path) {
    super(body?.message || `Request failed with status ${status}`)
    this.name = 'DiscordAPIError'
    this.code = body?.code ?? status
    this.status = status
    this.method = method
    this.path = path
    this.errors = body?.errors ?? null
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const backoff = attempt => 500 * 2 ** attempt + Math.floor(Math.random() * 250)

export class Rest {
  constructor() {
    this.token = null
  }

  async request(method, path, { body, files, reason, query } = {}, attempt = 0) {
    const url = new URL(API + path)
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value))
    const headers = { Authorization: `Bot ${this.token}`, 'User-Agent': USER_AGENT }
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason)
    let payload
    if (files?.length) {
      const form = new FormData()
      form.append('payload_json', JSON.stringify(body ?? {}))
      for (const file of files) form.append(`files[${file.id}]`, new Blob([file.data]), file.name)
      payload = form
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const again = () => this.request(method, path, { body, files, reason, query }, attempt + 1)
    const canRetry = attempt < MAX_RETRIES

    let res
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      if (canRetry && RETRYABLE_METHODS.includes(method)) {
        await sleep(backoff(attempt))
        return again()
      }
      throw err
    }

    if (res.status === 429 && canRetry) {
      const data = await res.json().catch(() => ({}))
      const wait = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1)
      await sleep(Math.ceil(wait * 1000))
      return again()
    }

    if (res.status >= 500 && canRetry && RETRYABLE_METHODS.includes(method)) {
      await sleep(backoff(attempt))
      return again()
    }

    if (res.status === 204) return null
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = { message: text.slice(0, 200) }
      }
    }
    if (!res.ok) throw new DiscordAPIError(res.status, json, method, path)
    return json
  }

  get(path, opts) {
    return this.request('GET', path, opts)
  }
  post(path, opts) {
    return this.request('POST', path, opts)
  }
  put(path, opts) {
    return this.request('PUT', path, opts)
  }
  patch(path, opts) {
    return this.request('PATCH', path, opts)
  }
  delete(path, opts) {
    return this.request('DELETE', path, opts)
  }
}
