// @ts-check
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import fs from 'fs'
import Stream, { Readable } from 'stream'

/** 
 * @param {ImportMeta | string} pathURL 
 * @param {boolean?} rmPrefix if value is `'true'`, it will remove `'file://'` prefix, if windows it will automatically false
 */
const __filename = function filename(pathURL = import.meta, rmPrefix = os.platform() !== 'win32') {
    const path = /** @type {ImportMeta} */ (pathURL).url || /** @type {String} */ (pathURL)
    return rmPrefix ?
        /file:\/\/\//.test(path) ?
            fileURLToPath(path) :
            path : /file:\/\/\//.test(path) ?
            path : pathToFileURL(path).href
}

/** @param {ImportMeta | string} pathURL */
const __dirname = function dirname(pathURL) {
    const dir = __filename(pathURL, true)
    const regex = /\/$/
    return regex.test(dir) ?
        dir : fs.existsSync(dir) &&
            fs.statSync(dir).isDirectory() ?
            dir.replace(regex, '') :
            path.dirname(dir)
}

/** @param {ImportMeta | string} dir */
const __require = function require(dir = import.meta) {
    const path = /** @type {ImportMeta} */ (dir).url || /** @type {String} */ (dir)
    return createRequire(path)
}

/** @param {string} file */
const checkFileExists = (file) => fs.promises.access(file, fs.constants.F_OK).then(() => true).catch(() => false)

/**
 * Parse command line arguments without yargs
 * @param {string[]} argv 
 * @param {Object} options 
 * @returns {Object}
 */
const parseArgs = (argv = process.argv.slice(2), options = {}) => {
    const result = { _: [] };
    const aliases = {};
    
    // Parse options format
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
        
        // Check for long option (--option)
        if (arg.startsWith('--')) {
            const optionName = arg.slice(2);
            const equalIndex = optionName.indexOf('=');
            
            if (equalIndex !== -1) {
                // --option=value
                const name = optionName.slice(0, equalIndex);
                const value = optionName.slice(equalIndex + 1);
                const actualName = aliases[name] || name;
                result[actualName] = value;
                i++;
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
                // --option value
                const actualName = aliases[optionName] || optionName;
                result[actualName] = argv[i + 1];
                i += 2;
            } else {
                // --option (boolean flag)
                const actualName = aliases[optionName] || optionName;
                result[actualName] = true;
                i++;
            }
        }
        // Check for short option (-o)
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
        // Positional argument
        else {
            result._.push(arg);
            i++;
        }
    }
    
    return result;
}

/**
 * Get prefix from arguments or use default
 * @param {Object} args 
 * @returns {RegExp}
 */
const getPrefix = (args) => {
    const prefixStr = args.prefix || '‎/!#.→';
    return new RegExp('^[' + prefixStr.replace(/[|\\{}()[\]^$+*?.\-\^]/g, '\\$&') + ']');
}

// Parse arguments
const options = {
    prefix: {
        alias: 'p',
        description: 'Prefix characters to filter'
    }
};

const opts = parseArgs(process.argv.slice(2), options);
const prefix = getPrefix(opts);

/**
 * @param {Readable} stream 
 * @param {string} file 
 * @returns {Promise<void>}
 */
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
        (!obj._writableState || obj._readableState?.readable !== false) && // Duplex
        (!obj._writableState || obj._readableState) // Writable has .pipe.
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

export default {
    __filename,
    __dirname,
    __require,
    checkFileExists,

    saveStreamToFile,
    isReadableStream,

    opts,
    prefix,
}