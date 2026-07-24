// ─── context.js ─────────────────────────────────────────────────────────────
// Singleton state yang dipakai bareng semua tool (dulunya variabel
// module-level `_conn`, `_currentM`, dst di mcp.js). Tool file di ./tools
// import ini, BUKAN import langsung dari mcp.js, biar gak circular-dependency
// dan biar jelas apa aja yang boleh diakses tool.
//
// mcp.js tetap yang nge-update isinya lewat setContext(), dipanggil dari
// setCurrentContext() yang sudah ada.

const state = {
    conn: null,
    currentM: null,
    currentJid: null,
    isOwner: false,
    isROwner: false,
    timezone: 'Asia/Jakarta',
}

export function setContext({ conn, m, jid, isOwner, isROwner, timezone }) {
    if (conn !== undefined) state.conn = conn
    if (m !== undefined) state.currentM = m
    if (jid !== undefined) state.currentJid = jid
    if (isOwner !== undefined) state.isOwner = isOwner
    if (isROwner !== undefined) state.isROwner = isROwner
    if (timezone !== undefined) state.timezone = timezone || 'Asia/Jakarta'
}

// Getter dipakai di tool file, contoh: `import { ctx } from '../context.js'`
// lalu `ctx().conn`, `ctx().currentJid`, dst. Pakai fungsi (bukan destructure
// langsung) supaya selalu ambil nilai TERBARU, bukan snapshot lama.
export function ctx() {
    return state
}

// ─── Lazy access ke mcp.js ──────────────────────────────────────────────────
// PENTING: tool file TIDAK BOLEH `import { x } from '../mcp.js'` secara
// STATIS. mcp.js manggil `await loadToolsDir()` di top-level buat load semua
// file di ./tools, dan kalau tool file itu balik import mcp.js secara statis,
// terjadi circular-import DEADLOCK ("unsettled top-level await") -- mcp.js
// gak akan pernah selesai loading, dan apapun yang import mcp.js (termasuk
// handler.js) ikut gagal jalan. Makanya semua akses ke helper mcp.js WAJIB
// lewat getMcp() di bawah, dipanggil di DALAM execute() (dieksekusi belakangan,
// setelah mcp.js selesai loading) -- bukan di top-level file.
let _mcpModule = null
export async function getMcp() {
    if (!_mcpModule) _mcpModule = await import('./mcp.js')
    return _mcpModule
}

// Alias lama, dipakai tools/reminder.js -- tetap disediakan biar kompatibel.
export async function getRunAgent() {
    const mod = await getMcp()
    return mod.runAgent
}
