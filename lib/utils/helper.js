import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import fs from 'fs'
import Stream, { Readable, PassThrough } from 'stream'
import { createHash } from 'crypto'
import vm from 'vm'

const __filename = function filename(pathURL = import.meta, rmPrefix = os.platform() !== 'win32') {
    const path = pathURL.url || pathURL
    return rmPrefix ?
        /file:\/\/\//.test(path) ?
            fileURLToPath(path) :
            path : /file:\/\/\//.test(path) ?
            path : pathToFileURL(path).href
}

const __dirname = function dirname(pathURL) {
    const dir = __filename(pathURL, true)
    const regex = /\/$/
    return regex.test(dir) ?
        dir : fs.existsSync(dir) &&
            fs.statSync(dir).isDirectory() ?
            dir.replace(regex, '') :
            path.dirname(dir)
}

const __require = function require(dir = import.meta) {
    const path = dir.url || dir
    return createRequire(path)
}

const checkFileExists = (file) => fs.promises.access(file, fs.constants.F_OK).then(() => true).catch(() => false)

const parseArgs = (argv = process.argv.slice(2), options = {}) => {
    const result = { _: [] };
    const aliases = {};

    const parsedOptions = {};
    Object.entries(options).forEach(([key, value]) => {
        if (value.alias) {
            aliases[value.alias] = key;
        }
        parsedOptions[key] = value;
    });

    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];

        if (arg.startsWith('--')) {
            const optionName = arg.slice(2);
            const equalIndex = optionName.indexOf('=');

            if (equalIndex !== -1) {
                const name = optionName.slice(0, equalIndex);
                const value = optionName.slice(equalIndex + 1);
                const actualName = aliases[name] || name;
                result[actualName] = value;
                i++;
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
                const actualName = aliases[optionName] || optionName;
                result[actualName] = argv[i + 1];
                i += 2;
            } else {
                const actualName = aliases[optionName] || optionName;
                result[actualName] = true;
                i++;
            }
        }
        else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
            const optionName = arg.slice(1);
            const actualName = aliases[optionName] || optionName;

            if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
                result[actualName] = argv[i + 1];
                i += 2;
            } else {
                result[actualName] = true;
                i++;
            }
        }
        else {
            result._.push(arg);
            i++;
        }
    }

    return result;
}

const options = {
    prefix: {
        alias: 'p',
        description: 'Prefix characters to filter'
    }
};

const opts = parseArgs(process.argv.slice(2), options);

// Resolve the active prefix list. Priority: CLI (--prefix / -p) > global.settings.system.prefix (config.js) > hardcoded fallback.
const resolvePrefix = () => {
    if (opts.prefix) return String(opts.prefix).split('');
    const sys = (global.settings && global.settings.system) || {};
    return Array.isArray(sys.prefix) && sys.prefix.length ? sys.prefix : ['.', '/', '!'];
}

const getPrefix = (list) => {
    const chars = Array.isArray(list) ? list.join('') : String(list || '');
    return new RegExp('^[' + chars.replace(/[|\\{}()[\]^$+*?.\-\^]/g, '\\$&') + ']');
}

// Resolve the fully-merged runtime opts object: CLI flags override global.settings.system (config.js) values.
// Boolean toggle keys are only included when true, to keep global.opts uncluttered — bracket access
// (e.g. global.opts['restrict']) still returns undefined (falsy) for omitted keys, so behavior is unchanged.
const BOOLEAN_TOGGLE_KEYS = ['queue', 'autoread', 'restrict', 'self', 'nyimak', 'pconly', 'gconly', 'swonly'];
const resolveOpts = () => {
    const sys = (global.settings && global.settings.system) || {};
    const toggles = {
        queue:    opts['queue']    ?? !!sys.queue,
        autoread: opts['autoread'] ?? !!sys.autoRead,
        restrict: opts['restrict'] ?? false,
        self:     opts['self']     ?? false,
        nyimak:   opts['nyimak']   ?? false,
        pconly:   opts['pconly']   ?? sys.OnlyRespondTo === 'dm',
        gconly:   opts['gconly']   ?? sys.OnlyRespondTo === 'group',
        swonly:   opts['swonly']   ?? sys.OnlyRespondTo === 'status',
    };
    const merged = { ...opts };
    for (const key of BOOLEAN_TOGGLE_KEYS) {
        if (toggles[key]) merged[key] = true;
    }
    return merged;
}

const prefixList = resolvePrefix();
const prefix = getPrefix(prefixList);
const runtimeOpts = resolveOpts();

const saveStreamToFile = (stream, file) => new Promise((resolve, reject) => {
    const writable = stream.pipe(fs.createWriteStream(file))
    writable.once('finish', () => {
        resolve()
        writable.destroy()
    })
    writable.once('error', () => {
        reject()
        writable.destroy()
    })
})

const kDestroyed = Symbol('kDestroyed');
const kIsReadable = Symbol('kIsReadable');
const isReadableNodeStream = (obj, strict = false) => {
    return !!(
        obj &&
        typeof obj.pipe === 'function' &&
        typeof obj.on === 'function' &&
        (
            !strict ||
            (typeof obj.pause === 'function' && typeof obj.resume === 'function')
        ) &&
        (!obj._writableState || obj._readableState?.readable !== false) &&
        (!obj._writableState || obj._readableState)
    );
}
const isNodeStream = (obj) => {
    return (
        obj &&
        (
            obj._readableState ||
            obj._writableState ||
            (typeof obj.write === 'function' && typeof obj.on === 'function') ||
            (typeof obj.pipe === 'function' && typeof obj.on === 'function')
        )
    );
}
const isDestroyed = (stream) => {
    if (!isNodeStream(stream)) return null;
    const wState = stream._writableState;
    const rState = stream._readableState;
    const state = wState || rState;
    return !!(stream.destroyed || stream[kDestroyed] || state?.destroyed);
}
const isReadableFinished = (stream, strict) => {
    if (!isReadableNodeStream(stream)) return null;
    const rState = stream._readableState;
    if (rState?.errored) return false;
    if (typeof rState?.endEmitted !== 'boolean') return null;
    return !!(
        rState.endEmitted ||
        (strict === false && rState.ended === true && rState.length === 0)
    );
}
const isReadableStream = (stream) => {
    if (typeof Stream.isReadable === 'function') return Stream.isReadable(stream)
    if (stream && stream[kIsReadable] != null) return stream[kIsReadable];
    if (typeof stream?.readable !== 'boolean') return null;
    if (isDestroyed(stream)) return false;
    return (
        isReadableNodeStream(stream) &&
        !!stream.readable &&
        !isReadableFinished(stream)
    ) || stream instanceof fs.ReadStream || stream instanceof Readable;
}

function hashFileContent(filePath) {
    try {
        const content = fs.readFileSync(filePath)
        return createHash('md5').update(content).digest('hex').slice(0, 12)
    } catch (e) {
        return `fallback-${Date.now()}`
    }
}

function normalizePlugin(mod) {
    if (typeof mod === 'function') return mod
    if (mod && typeof mod.run === 'function') {
        const { run, ...props } = mod
        const fn = function (...args) { return run.apply(this, args) }
        Object.assign(fn, props)
        return fn
    }
    return mod
}

async function importFile(module) {
    module = __filename(module)
    const rawPath = __filename(module, true)
    const cacheKey = hashFileContent(rawPath)
    const module_ = await import(`${module}?id=${cacheKey}`)
    const result = module_ && 'default' in module_ ? module_.default : module_
    return normalizePlugin(result)
}

function checkSyntax(src, filename = 'unknown', opts = {}) {
    let code = Buffer.isBuffer(src) ? src.toString('utf8') : String(src)
    const originalLineCount = code.split('\n').length

    if (opts.sourceType === 'module') {
        code = code.replace(/^([ \t]*)import\s+[a-zA-Z0-9_$]+\s*,\s*\{\s*(?:[a-zA-Z0-9_$]+(?:\s+as\s+[a-zA-Z0-9_$]+)?\s*,\s*)*[a-zA-Z0-9_$]+(?:\s+as\s+[a-zA-Z0-9_$]+)?\s*,?\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)import\s*\{\s*(?:[a-zA-Z0-9_$]+(?:\s+as\s+[a-zA-Z0-9_$]+)?\s*,\s*)*[a-zA-Z0-9_$]+(?:\s+as\s+[a-zA-Z0-9_$]+)?\s*,?\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)import\s*\{\s*\n(?:\s*[a-zA-Z0-9_$]+(?:\s+as\s+[a-zA-Z0-9_$]+)?\s*,?\s*\n)*\s*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/gm, (block) => {
            return block.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)export\s*\{[^}]*\}\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)import\s+[a-zA-Z0-9_$*]+(\s+as\s+[a-zA-Z0-9_$]+)?\s+from\s*['"][^'"]*['"]\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)import\s*\*\s*as\s+[a-zA-Z0-9_$]+\s+from\s*['"][^'"]*['"]\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)import\s*['"][^'"]*['"]\s*;?\s*$/gm, (line) => {
            return line.replace(/[^\n]/g, ' ')
        })
        code = code.replace(/^([ \t]*)export\s+default\s+/gm, (line, indent) => {
            return indent + '  '.repeat(0) + 'void '.padEnd('export default '.length - indent.length, ' ')
        })
        code = code.replace(/^([ \t]*)export\s+(async\s+function|function|class|const|let|var)\b/gm, (line, indent, kw) => {
            const stripped = 'export '.length
            return indent + ' '.repeat(stripped) + kw
        })
        code = code.replace(/import\.meta/g, '({url:""})')
    }

    let wrapped = code
    if (opts.allowReturnOutsideFunction || opts.allowAwaitOutsideFunction) {
        wrapped = `(async function(){\n${code}\n})`
    }

    try {
        new vm.Script(wrapped, { filename })
        return null
    } catch (e) {
        if (!(e instanceof SyntaxError)) return null

        const stackLines = (e.stack || '').split('\n')
        let line = 0
        let column = 0

        const markerIdx = stackLines.findIndex(l => /^\s*\^+\s*$/.test(l))
        if (markerIdx > 0) {
            const codeLine = stackLines[markerIdx - 1] || ''
            const marker = stackLines[markerIdx]
            column = marker.indexOf('^') + 1
            const upToHere = wrapped.split('\n')
            for (let i = 0; i < upToHere.length; i++) {
                if (upToHere[i] === codeLine) { line = i + 1; break }
            }
        }

        if (wrapped !== code && line > 0) line -= 1
        if (line > originalLineCount) line = originalLineCount

        const message = e.message || 'SyntaxError'
        const result = {
            message,
            line,
            column,
            toString() {
                return `${filename}:${line}\n${message}`
            }
        }
        return result
    }
}

// ==================== minimal logger (replaces pino) ====================
const LOG_LEVELS = { silent: 70, fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 }

function serializeError(err) {
    if (!(err instanceof Error)) return err
    return { type: err.name, message: err.message, stack: err.stack, ...err }
}

function createLogger(bindings = {}, level = 'info', timestampFn) {
    const state = { level }

    function write(levelName, args) {
        if (LOG_LEVELS[levelName] < LOG_LEVELS[state.level]) return
        let obj = {}
        let msg = ''
        if (args.length && typeof args[0] === 'object' && args[0] !== null) {
            obj = args[0]
            msg = args[1] ?? ''
        } else {
            msg = args[0] ?? ''
        }
        if (obj.err) obj = { ...obj, err: serializeError(obj.err) }
        const line = { level: LOG_LEVELS[levelName], ...(timestampFn ? {} : { time: Date.now() }), ...bindings, ...obj, msg }
        const out = levelName === 'error' || levelName === 'fatal' ? process.stderr : process.stdout
        let json = JSON.stringify(line)
        if (timestampFn) json = json.slice(0, 1) + timestampFn() + json.slice(1)
        out.write(json + '\n')
    }

    return {
        get level() { return state.level },
        set level(v) { state.level = v },
        trace: (...a) => write('trace', a),
        debug: (...a) => write('debug', a),
        info: (...a) => write('info', a),
        warn: (...a) => write('warn', a),
        error: (...a) => write('error', a),
        fatal: (...a) => write('fatal', a),
        child(childBindings = {}) {
            return createLogger({ ...bindings, ...childBindings }, state.level, timestampFn)
        }
    }
}

/** Drop-in replacement for `pino`'s default export: `P(opts)` returns a root logger. */
function P(opts = {}) {
    return createLogger({}, opts.level || 'info', opts.timestamp)
}

// ==================== magic-byte file type detection (replaces file-type) ====================
const FILE_SIGNATURES = [
    { ext: 'png', mime: 'image/png', match: b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: 'jpg', mime: 'image/jpeg', match: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    {
        ext: 'gif',
        mime: 'image/gif',
        match: b => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
    },
    {
        ext: 'webp',
        mime: 'image/webp',
        match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    },
    { ext: 'bmp', mime: 'image/bmp', match: b => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
    {
        ext: 'tif',
        mime: 'image/tiff',
        match: b => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    },
    { ext: 'ico', mime: 'image/x-icon', match: b => b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
    { ext: 'heic', mime: 'image/heic', match: b => b.length >= 12 && isIsoBmff(b) && ftypBrandStartsWith(b, ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']) },
    { ext: 'avif', mime: 'image/avif', match: b => b.length >= 12 && isIsoBmff(b) && ftypBrandStartsWith(b, ['avif', 'avis']) },
    { ext: 'ebml', mime: 'video/webm', match: b => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
    { ext: 'mp4', mime: 'video/mp4', match: b => b.length >= 12 && isIsoBmff(b) && ftypBrandStartsWith(b, ['isom', 'iso2', 'mp41', 'mp42', 'mp4v', 'avc1', 'M4V ', 'M4A ', 'dash']) },
    { ext: 'mov', mime: 'video/quicktime', match: b => b.length >= 12 && isIsoBmff(b) && ftypBrandStartsWith(b, ['qt  ']) },
    {
        ext: 'avi',
        mime: 'video/x-msvideo',
        match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20
    },
    { ext: 'mp3', mime: 'audio/mpeg', match: b => b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
    { ext: 'ogg', mime: 'audio/ogg', match: b => b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
    {
        ext: 'wav',
        mime: 'audio/wav',
        match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45
    },
    { ext: 'm4a', mime: 'audio/mp4', match: b => b.length >= 12 && isIsoBmff(b) && ftypBrandStartsWith(b, ['M4A ']) },
    { ext: 'flac', mime: 'audio/x-flac', match: b => b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43 },
    { ext: 'amr', mime: 'audio/amr', match: b => b.length >= 6 && b.subarray(0, 6).toString('latin1') === '#!AMR\n' },
    { ext: 'pdf', mime: 'application/pdf', match: b => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
    {
        ext: 'zip',
        mime: 'application/zip',
        match: b => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)
    },
    { ext: 'rar', mime: 'application/x-rar-compressed', match: b => b.length >= 6 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07 },
    { ext: '7z', mime: 'application/x-7z-compressed', match: b => b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c },
    { ext: 'gz', mime: 'application/gzip', match: b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b }
]

function isIsoBmff(b) {
    return b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
}
function ftypBrandStartsWith(b, brands) {
    const majorBrand = b.subarray(8, 12).toString('latin1')
    return brands.some(brand => majorBrand === brand)
}

/** Drop-in for file-type's fileTypeFromBuffer(). Returns { ext, mime } or undefined. */
async function fileTypeFromBuffer(buffer) {
    if (!buffer || buffer.length === 0) return undefined
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    for (const sig of FILE_SIGNATURES) {
        if (sig.match(buf)) {
            if (sig.ext === 'ebml') {
                const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1')
                if (head.includes('matroska')) return { ext: 'mkv', mime: 'video/x-matroska' }
                return { ext: 'webm', mime: 'video/webm' }
            }
            return { ext: sig.ext, mime: sig.mime }
        }
    }
    return undefined
}

const FILE_TYPE_PEEK_BYTES = 4100

/** Drop-in for file-type's fileTypeStream(): detects type without losing stream data. */
async function fileTypeStream(readableStream) {
    const chunks = []
    let collected = 0

    await new Promise((resolve, reject) => {
        const onData = chunk => {
            chunks.push(chunk)
            collected += chunk.length
            if (collected >= FILE_TYPE_PEEK_BYTES) {
                readableStream.pause()
                readableStream.off('data', onData)
                resolve()
            }
        }
        readableStream.on('data', onData)
        readableStream.once('end', resolve)
        readableStream.once('error', reject)
    })

    const head = Buffer.concat(chunks, collected)
    const detected = await fileTypeFromBuffer(head)

    const output = new PassThrough()
    output.fileType = detected
    output.write(head)
    if (readableStream.readableEnded || readableStream.destroyed) output.end()
    else readableStream.pipe(output)

    return output
}

export default {
    __filename,
    __dirname,
    __require,
    checkFileExists,

    saveStreamToFile,
    isReadableStream,

    importFile,
    checkSyntax,

    opts,
    prefix,
    prefixList,
    runtimeOpts,
    resolvePrefix,
    resolveOpts,
    getPrefix,

    P,
    fileTypeFromBuffer,
    fileTypeStream,
}
