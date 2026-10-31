const stealthFn = () => {
    const defProp = (obj, key, get) => {
        try { Object.defineProperty(obj, key, { get, configurable: true, enumerable: true }) } catch {}
    }

    const navProto = typeof Navigator !== 'undefined' ? Navigator.prototype : typeof navigator !== 'undefined' ? navigator : null
    if (navProto) {
        defProp(navProto, 'webdriver', () => undefined)
        defProp(navProto, 'languages', () => ['en-US', 'en'])
        defProp(navProto, 'platform', () => 'Win32')
        defProp(navProto, 'vendor', () => 'Google Inc.')
        defProp(navProto, 'hardwareConcurrency', () => 8)
        defProp(navProto, 'deviceMemory', () => 8)
    }

    const makePlugin = (name, filename, mimeType) => {
        try {
            const mime = Object.create(MimeType.prototype)
            defProp(mime, 'type', () => mimeType)
            defProp(mime, 'suffixes', () => 'pdf')
            defProp(mime, 'description', () => '')
            const plugin = Object.create(Plugin.prototype)
            defProp(plugin, 'name', () => name)
            defProp(plugin, 'filename', () => filename)
            defProp(plugin, 'description', () => '')
            defProp(plugin, 'length', () => 1)
            plugin[0] = mime
            plugin.item = (i) => (i === 0 ? mime : null)
            plugin.namedItem = (n) => (n === mimeType ? mime : null)
            return plugin
        } catch { return null }
    }

    try {
        const plugins = [
            makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'application/x-google-chrome-pdf'),
            makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'application/pdf'),
            makePlugin('Native Client', '', 'application/x-nacl')
        ].filter(Boolean)
        plugins.item = (i) => plugins[i] ?? null
        plugins.namedItem = (n) => plugins.find(p => p.name === n) ?? null
        plugins.refresh = () => {}
        if (navProto) defProp(navProto, 'plugins', () => plugins)
    } catch {}

    try {
        if (navigator.permissions) {
            const origQuery = navigator.permissions.query.bind(navigator.permissions)
            navigator.permissions.__proto__.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission, onchange: null })
                    : origQuery(params)
        }
    } catch {}

    if (!window.chrome) {
        window.chrome = {
            app: { isInstalled: false },
            runtime: {
                id: undefined,
                connect() {},
                sendMessage() {}
            }
        }
    }

    for (const k of Object.keys(window)) {
        if (/^(cdc_|__cdc|__webdriver|__selenium|__nightmare|phantom|callPhantom|_phantom)/.test(k)) {
            try { delete window[k] } catch {}
        }
    }

    const patchWebGL = (proto) => {
        try {
            const orig = proto.getParameter
            proto.getParameter = function(param) {
                if (param === 37445) return 'Intel Inc.'
                if (param === 37446) return 'Intel(R) Iris(TM) Plus Graphics 640'
                return orig.call(this, param)
            }
        } catch {}
    }
    if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype)
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype)
}

export const STEALTH_SOURCE = `(${stealthFn.toString()})()`
