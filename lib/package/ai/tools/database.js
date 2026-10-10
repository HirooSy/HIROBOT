import { ctx, parseDbKeyPath } from '../mcp.js';
export default [
{
    name: 'read_database',
    description: 'Read the structure/content of the running bot database (db.data) — read DIRECTLY from memory, so it works whatever the adapter is (local JSON file, MongoDB, MySQL, Cloud DB). Use it to check the REAL data structure (key/field names, value types, sample content) while debugging/auto-healing — do not guess from the code alone, especially when the error involves db.data. Note: read_file can only read database.json if the adapter is a local file; for remote adapters (Mongo/MySQL/Cloud DB) read_database is the ONLY way to see the content. The "password" field is automatically masked for security.',
    parameters: {
        key_path: { type: 'string', description: 'Key path in db.data. Plain dot notation for keys without dots, e.g. "users" (all users), "settings". Keys that CONTAIN A DOT (most often a WhatsApp JID) MUST be wrapped in bracket+quote so they are not split wrongly, for example: \'users["6281234567890@s.whatsapp.net"]\' (one specific user), \'chats["1234@g.us"].settings\'. (There is an auto-merge fallback if you forget the brackets, but brackets are more certain to be correct.) Leave empty to first see the list of top-level keys along with their entry counts.', required: false },
        limit: { type: 'number', description: 'If the result is an object with many entries (e.g. all users), limit the number of entries shown (default 5) to save tokens — call again with a more specific key_path to see particular entries.', required: false }
    },
    execute: async ({ key_path = '', limit = 5 }) => {
        if (!db?.data) return 'FAILED: db.data is not ready (not loaded yet) — make sure await db.read() has run.'

        if (!key_path) {
            const summary = Object.entries(db.data).map(([k, v]) => {
                const count = v && typeof v === 'object' ? Object.keys(v).length : ''
                return `- ${k}${count !== '' ? ` (${count} entries)` : ''}`
            }).join('\n')
            return `Top-level keys in db.data:\n${summary}\n\nCall again with a key_path (e.g. "users") to see its content.`
        }

        const parts = parseDbKeyPath(key_path)
        if (!parts.length) return 'FAILED: key_path is not valid.'
        let node = db.data
        for (const p of parts) {
            if (node == null || typeof node !== 'object' || !(p in node)) {
                return `FAILED: "${key_path}" was not found in db.data.`
            }
            node = node[p]
        }

        const redact = (obj) => {
            if (Array.isArray(obj)) return obj.map(redact)
            if (obj && typeof obj === 'object') {
                const out = {}
                for (const [k, v] of Object.entries(obj)) {
                    out[k] = (k === 'password') ? '[REDACTED]' : redact(v)
                }
                return out
            }
            return obj
        }

        let result = redact(node)
        let note = ''
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            const entries = Object.entries(result)
            if (entries.length > limit) {
                result = Object.fromEntries(entries.slice(0, limit))
                note = `\n\n[Showing ${limit} of ${entries.length} entries — call again with a more specific key_path (e.g. "users.<one of the keys above>") or a larger limit if you need to see the rest.]`
            }
        }

        return `db.data.${key_path}:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`${note}`
    }
},
{
    name: 'write_database',
    description: 'Change/delete content in the running bot database (db.data) — directly in memory, just like "db.data.users[user].name = \'Hiro\'" in code. NEVER use write_file to edit the database (e.g. database.json) — that only writes a file on disk, is NOT in sync with the db.data running in memory, and can corrupt data/get overwritten back whatever the adapter is (local JSON, MongoDB, MySQL, Cloud DB). write_database is the ONLY correct way to edit the database, because it automatically persists through db.write() (whatever the adapter). OWNER-ONLY — regular users may not use this tool.',
    parameters: {
        key_path: { type: 'string', description: 'Key path in db.data, same as used in read_database. Plain dot notation is fine for keys without dots, e.g. "settings.prefix". Keys that CONTAIN A DOT (most often a WhatsApp JID, e.g. "628xxx@s.whatsapp.net", "1234@g.us") MUST be wrapped in bracket+quote so they are not split wrongly, for example: \'users["628xxx@s.whatsapp.net"].name\', \'chats["1234@g.us"].settings.welcome\'. (There is an auto-merge fallback if you forget the brackets, but brackets are safer/more certain to be correct.) If an intermediate key does not exist yet, it is created automatically as an empty object (except for operation "delete") — the result will give a WARNING if this creates a new users/chats record, check that warning to make sure it is not a typo.', required: true },
        value: { type: 'string', description: 'The new value, as a JSON literal (strings must use double quotes, e.g. "Hiro"; number: 5; boolean: true; object: {"a":1}; array: [1,2,3]). Required when operation is "set" (default). Ignored when operation is "delete".', required: false },
        operation: { type: 'string', description: '"set" (default) to change/add a value, or "delete" to remove that key completely from db.data.', required: false }
    },
    execute: async ({ key_path, value, operation = 'set' }) => {
        if (!db?.data) return 'FAILED: db.data is not ready (not loaded yet) — make sure await db.read() has run.'
        if (!key_path) return 'FAILED: key_path is required.'

        const parts = parseDbKeyPath(key_path)
        if (!parts.length) return 'FAILED: key_path is not valid.'

        const lastKey = parts[parts.length - 1]
        let node = db.data

        if (operation === 'delete') {
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i]
                if (node == null || typeof node !== 'object' || !(p in node)) {
                    return `FAILED: path "${key_path}" was not found in db.data.`
                }
                node = node[p]
            }
            if (node == null || typeof node !== 'object' || !(lastKey in node)) {
                return `FAILED: key "${key_path}" was not found in db.data.`
            }
            const oldVal = node[lastKey]
            delete node[lastKey]
            try {
                if (typeof db.write === 'function') await db.write()
            } catch (e) {
                node[lastKey] = oldVal 
                return `FAILED to save the change to the database: ${e.message}`
            }
            return `Deleted: db.data.${key_path}\n(old value: ${JSON.stringify(oldVal)})`
        }

        if (value === undefined) return 'FAILED: value is required for operation "set".'
        let parsedValue
        try {
            parsedValue = JSON.parse(value)
        } catch (_) {

            parsedValue = value
        }

        let autoCreatedWarning = ''
        if (parts.length >= 2 && (parts[0] === 'users' || parts[0] === 'chats')) {
            const collection = db.data[parts[0]]
            if (collection && typeof collection === 'object' && !(parts[1] in collection)) {
                autoCreatedWarning = `\n\n⚠️ WARNING: the record "${parts[0]}.${parts[1]}" DID NOT EXIST in the database before, so it was just created automatically as an empty object. If you meant to edit an EXISTING user/chat, the key_path is most likely wrong (JID typo, or forgotten bracket-quote for a JID that contains dots) — check again with read_database before continuing.`
            }
        }
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i]
            if (node[p] == null || typeof node[p] !== 'object') {
                node[p] = {}
            }
            node = node[p]
        }

        const oldVal = node[lastKey]
        node[lastKey] = parsedValue
        try {
            if (typeof db.write === 'function') await db.write()
        } catch (e) {
            node[lastKey] = oldVal 
            return `FAILED to save the change to the database: ${e.message}`
        }
        return `Set: db.data.${key_path} = ${JSON.stringify(parsedValue)}\n(old value: ${JSON.stringify(oldVal)})${autoCreatedWarning}`
    }
}
]
