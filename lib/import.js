// inspired from https://github.com/nodejs/modules/issues/307#issuecomment-858729422

// import { resolve } from 'path'
// import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import Helper from './helper.js'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const WORKER_DIR = Helper.__dirname(import.meta.url, false)
// const WORKER_FILE = Helper.__filename(resolve(WORKER_DIR, './import.js'), false)

// if (!isMainThread) importModule(workerData)

// async function importModule(file) {
//     file = Helper.__filename(file)
//     const module = await import(file).catch(console.error)
//     const result = module && 'default' in module ? module.default : module
//     parentPort.postMessage(JSON.stringify(result), result)
// }

/**
 * Hash isi file — dipakai sebagai cache-busting query string.
 * Beda dari Date.now(), ini cuma berubah kalau ISI file beneran berubah,
 * jadi Node nggak nge-cache module baru yang identik tiap kali di-reload
 * tanpa ada perubahan nyata (mencegah ESM module cache numpuk permanen).
 * @param {string} filePath - path filesystem asli (bukan file:// URL)
 * @returns {string}
 */
function hashFileContent(filePath) {
    try {
        const content = readFileSync(filePath)
        return createHash('md5').update(content).digest('hex').slice(0, 12)
    } catch (e) {
        // Kalau gagal baca (race condition file kehapus dsb), fallback ke
        // timestamp biar tetap jalan, walau nggak dapat manfaat dedupe-nya.
        return `fallback-${Date.now()}`
    }
}

/**
 * @template T
 * @param {string} module 
 * @returns {Promise<T>}
 */
export default async function importLoader(module) {
    // return new Promise((resolve, reject) => {
    //     const worker = new Worker(new URL(WORKER_FILE), {
    //         workerData: module
    //     })
    //     const killWorker = () => worker.terminate().catch(() => { })
    //     worker.once('message', (msg) => (killWorker(), console.log(msg.data), resolve(msg)))
    //     worker.once('error', (error) => (killWorker(), reject(error)))
    // })
    module = Helper.__filename(module)
    // Path asli tanpa "file://" prefix, dipakai buat baca isi file untuk hashing
    const rawPath = Helper.__filename(module, true)
    const cacheKey = hashFileContent(rawPath)
    const module_ = await import(`${module}?id=${cacheKey}`)
    const result = module_ && 'default' in module_ ? module_.default : module_
    return result
}