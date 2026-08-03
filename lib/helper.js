import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import fs from 'fs'
import Stream, { Readable } from 'stream'
import { createHash } from 'crypto'

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

const getPrefix = (args) => {
    const prefixStr = args.prefix || '‎/!#.→';
    return new RegExp('^[' + prefixStr.replace(/[|\\{}()[\]^$+*?.\-\^]/g, '\\$&') + ']');
}

const options = {
    prefix: {
        alias: 'p',
        description: 'Prefix characters to filter'
    }
};

const opts = parseArgs(process.argv.slice(2), options);
const prefix = getPrefix(opts);

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

export default {
    __filename,
    __dirname,
    __require,
    checkFileExists,

    saveStreamToFile,
    isReadableStream,

    importFile,

    opts,
    prefix,
}
