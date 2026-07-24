let handler = m => m

handler.all = async function (m) {
    if (m.fromMe || m.isBaileys) return
    if (m.chat?.endsWith("@newsletter")) return
    
    // ✅ Tambahkan inisialisasi default jika belum ada
    if (!db.data.chats[m.chat]) {
        db.data.chats[m.chat] = { isBanned: false }
    }
    if (!db.data.users[m.sender]) {
        db.data.users[m.sender] = { banned: false }
    }
    
    // ✅ Cek dengan optional chaining dan default value
    if (db.data.chats[m.chat]?.isBanned) return
    if (db.data.users[m.sender]?.banned) return
    
    let msgs = db.data.msgs
    if (!(m.text in msgs)) return
    
    let _m = this.serializeM(JSON.parse(JSON.stringify(msgs[m.text]), (_, v) => {
        if (v !== null && typeof v === 'object' && 'type' in v && v.type === 'Buffer' && 'data' in v && Array.isArray(v.data)) {
            return Buffer.from(v.data)
        }
        return v
    }))
    
    await _m.copyNForward(m.chat, true)
}

export default handler