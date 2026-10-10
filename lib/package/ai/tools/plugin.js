import { ctx, classifyPluginRisk, downloadTwitterDirect, execEval, execPluginCommand, pluginRequirements, resolvePlugin, riskBadge, aiOnly, PLUGIN_OUT_START, PLUGIN_OUT_END } from '../mcp.js';
import db from '../../../utils/database.js'
import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()

export default [
{
    name: 'run_eval',
    description: 'Run custom JavaScript code through the bot\'s eval plugin (equivalent to manually typing "<< code" in the chat). Can ONLY be used by the REAL OWNER of the bot (rowner) -- non-owners are always rejected. There is NO extra confirmation before execution (unlike other medium/none risk commands) -- once called, the code is EXECUTED IMMEDIATELY with full access to the bot runtime (conn, db, m, etc). Use it ONLY when the owner explicitly asks to run specific code/eval/script — NEVER call this on your own initiative without an explicit instruction from the owner in that same turn.',
    parameters: {
        code: { type: 'string', description: 'The JavaScript code to execute, EXACTLY as the owner meant it (do not change/"fix" it yourself unless asked). Example: \'m.reply("hello world")\'', required: true },
        silent: { type: 'boolean', description: 'true = silent execution (equivalent to the prefix "< ", no return value reply is shown). false/default = show the return value (equivalent to the prefix "<< ").', required: false }
    },
    execute: async ({ code, silent = false }) => {
        try {
            await execEval(code, { silent })
            return `[ALREADY SENT to the user (eval code was executed${silent ? ', silent mode' : ''}). If the execution produced a reply/output to the chat, it was already sent directly by the plugin -- DO NOT rewrite that output. DO NOT send any reply text after this unless a short confirmation is really needed, in your own words (e.g. "Done running it ✅"). If there is nothing to add, just answer with an empty string.]`
        } catch (e) {
            return `Failed to run eval: ${e.message}`
        }
    }
},
{
    name: 'list_plugins',
    description: 'The ONLY source of truth about which commands/plugins really exist in this bot AND are exposed to the AI (plugins without handler.ai will not appear here at all, because they are treated as system/internal-only) — its data source is exactly the same as the bot\'s built-in ".menu" command (plugin.help + plugin.tags), not a guess/memory from file names or another bot. MUST be called every time the user asks which commands/features/plugins are available — NEVER answer from memory/guesses because this bot does NOT HAVE generic commands like get_random_x or an AI image generation feature unless they really appear in this tool result. Also use it before run_plugin to learn the correct command name. Each command is marked with a risk badge for the AI Agent (banned, high, medium, low, unclassified — see the full explanation in the run_plugin description; this limits the AI Agent, not the user) so you immediately know which ones may be run freely and which need the owner/confirmation first. Existing categories: main, group, sticker, ai, internet, adult, tools, downloader, owner, info.',
    parameters: {
        category: { type: 'string', description: 'Category/tag filter (optional). Example: "main", "group", "downloader", "owner"', required: false }
    },
    execute: async ({ category } = {}) => {
        try {
            const { plugins } = await import('../../../utils/plugins.js')

            const entries = Object.entries(plugins)

                .filter(([, plugin]) => plugin && !plugin.disabled && plugin.help && plugin.ai && typeof plugin.ai === 'object')
                .map(([name, plugin]) => {
                    const helpList = Array.isArray(plugin.help) ? plugin.help : [plugin.help]
                    const tags = Array.isArray(plugin.tags) ? plugin.tags : (plugin.tags ? [plugin.tags] : [])
                    const cmds = helpList
                        .map(h => String(h).split(' ')[0])
                        .filter((c, i, arr) => c && arr.indexOf(c) === i)
                    const risk = classifyPluginRisk(name, plugin)
                    const reqs = pluginRequirements(plugin)
                    return { tags, cmds, reqs, risk: risk.level }
                })
                .filter(e => e.cmds.length)

            const filtered = category
                ? entries.filter(e => e.tags.some(t => String(t).toLowerCase() === category.toLowerCase()))
                : entries

            if (!filtered.length) return `No commands found${category ? ` for category "${category}"` : ''}.\nAvailable categories: main, group, sticker, ai, internet, adult, tools, downloader, owner, info`

            const grouped = {}
            for (const e of filtered) {
                const tag = e.tags[0] || 'other'
                if (!grouped[tag]) grouped[tag] = []
                grouped[tag].push(e)
            }

            const totalCmds = filtered.reduce((n, e) => n + e.cmds.length, 0)
            let out = `*Bot commands (${totalCmds}, same source as .menu):*\n_Flags: [L] limit  [P] premium  [G] group-only  [D] DM-only  [A] group admin  [B] bot-admin_\n\n`
            for (const [tag, list] of Object.entries(grouped)) {
                out += `*${tag}*\n`
                for (const e of list) {
                    const flags = [
                        e.reqs.limit ? '[L]' : '',
                        e.reqs.premium ? '[P]' : '',
                        e.reqs.group ? '[G]' : '',
                        e.reqs.private ? '[D]' : '',
                        e.reqs.admin ? '[A]' : '',
                        e.reqs.botAdmin ? '[B]' : '',
                    ].filter(Boolean).join('')
                    out += `  • ${e.cmds.join(', ')}${flags ? ` ${flags}` : ''}\n`
                }
                out += '\n'
            }
            return out.trim().slice(0, 4000)
        } catch (e) {
            return `Failed to read plugin list: ${e.message}`
        }
    }
},
{
    name: 'run_plugin',
    description: `Run one of the bot's existing FEATURES. This is equivalent to the user typing ".feature_name" in the chat.

IMPORTANT: the risk level system below is a restriction for the AI AGENT (you), NOT a restriction for human users -- users may always still run any command manually by typing it directly in the chat (".command"), regardless of its risk level. What is limited here is purely which commands YOU may run automatically on behalf of the user through this tool.

Plugins WITHOUT handler.ai can never be run through this tool (they are treated as system/internal-only). For plugins that have handler.ai, the risk level is TRUSTED DIRECTLY from the plugin's own handler.ai.risk + handler.ai.description declaration (check first with check_plugin_risk if in doubt, or look at the badge in list_plugins) — except for the most sensitive system commands (rowner-only, exec/session/secret) which stay hard BANNED whatever the plugin declares. NOTE: handler.ai.summarize decides WHETHER the plugin result is held and you recompose it into a natural answer (true), or the plugin sends its reply directly to the user itself and you just stay quiet (false/default) — see the instruction inside the tool result after run_plugin is called, and follow it:
  banned -> system/dangerous/rowner-only (hard block, the plugin cannot change it), OR the plugin simply has no handler.ai. The AI Agent is STRICTLY FORBIDDEN from running this through this tool, whoever the requester is including the owner -- this is different from forbidding the user, the user may still type it manually. This tool will REFUSE by itself, do not force it.
  high -> declared by the plugin as an owner-only/mass/destructive action. Two gates at once: (1) it only runs if the sender is the owner, (2) AFTER that this tool STILL ASKS FOR CONFIRMATION first (returns the error "CONFIRM_REQUIRED") -- ask the owner explicitly first, then call again with confirmed: true if the owner agrees. Different from banned: high CAN STILL run as long as it is the owner + confirmed, banned can NOT run at all under any condition.
  medium -> declared by the plugin as a small/reversible state change, any user may use it. This tool will ASK FOR CONFIRMATION first (returns the error "CONFIRM_REQUIRED") — when that happens, ASK the user whether they are sure, and ONLY if the user has explicitly agreed, call run_plugin again with confirmed: true.
  low -> declared by the plugin as safe & idempotent (sticker, ping, downloader, etc) — examples: "sticker"/"s" ONLY converts the replied/attached image/video into a sticker, "tiktok"/"ig" ONLY download media from public URLs. Run it immediately without hesitation, without asking anything.
  unclassified (none) -> the plugin has handler.ai but has NOT declared a valid risk. DO NOT just ask the user whether it is allowed like medium. This tool will return the error "UNCLASSIFIED" containing the plugin's file path -- if the current requester is the owner, read that plugin's source code (read_file), decide for yourself the most fitting risk level (banned/high/medium/low) from how the code works, then write it back to that file (write_file) filling in the risk+description fields in handler.ai (do not change other parts), and only then call run_plugin again with the same command. If the requester is not the owner, do NOT edit any file -- tell the user this command has not been verified and the owner needs to configure it first.

Besides risk, there are separate context requirements from the plugin's other flags (handler.group, handler.private, handler.premium, handler.admin, handler.botAdmin) which are ALSO checked automatically and can make this tool refuse even if the risk is low: group-only commands are rejected when called from a DM (and the reverse for DM-only), premium-only commands are rejected if the sender is not premium/owner, admin-only commands are rejected if the sender is not an admin of this group, commands that need the bot to be admin are rejected if the bot is not an admin in that group.

The "menu" command is confirmed safe for ALL users — run it immediately without asking anything first, following the MENU rule in the system prompt. Similar commands that are not verified (e.g. "help", "allmenu", "list") might show owner-only commands to regular users depending on the plugin implementation, so this tool specifically holds those commands back for non-owners.

IMPORTANT ABOUT MULTI-STEP PLUGINS (e.g. the "twitter"/"x" downloader): some plugins (usually downloaders with many quality/format options) work in 2 stages -- run_plugin only runs the FIRST STAGE (sending the link, the plugin replies with a numbered list of choices). The SECOND STAGE (the user typing the chosen number) is HANDLED THROUGH A SEPARATE MECHANISM (handler.before) which CANNOT be triggered again through run_plugin -- run_plugin ONLY knows how to run a command from the beginning again, not how to "continue" an existing state.

FOR THIS TYPE OF DOWNLOADER PLUGIN, DO NOT USE run_plugin AT ALL -- use the download_media tool instead (the "twitter" platform in download_media already runs the scraper directly, without the numbered flow). If the platform the user asked for is not supported in download_media either, do NOT try to work around it with run_plugin for those multi-stage downloader plugins (it will only get stuck at the first stage) -- tell the user that platform is not supported for auto-download through the AI yet.`,
    parameters: {
        command: { type: 'string', description: 'The command/plugin name EXACTLY as registered (check list_plugins/check_plugin_risk if in doubt), without prefix, and do NOT translate it from the user\'s natural-language intent. Example: the user asks for "ping" → command: "ping". IMPORTANT for plugins whose format is "plugin_name <argument>" (see handler.help in list_plugins, e.g. "simulate <event> [@mention]"): the command STAYS the plugin name ("simulate"), the arguments after it ("bye", "promote", etc) go into the args parameter, NOT made into a command of their own. Wrong example: the user says "try simulate bye" and command:"bye" is called — this is WRONG because "bye" is not a plugin name, it is the event argument for the "simulate" plugin. Correct example: command:"simulate", args:"bye".', required: true },
        args: { type: 'string', description: 'Extra arguments for the command (optional)', required: false },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the user has explicitly agreed to run a command that previously asked for confirmation (CONFIRM_REQUIRED). Never set true beforehand without the user\'s approval.', required: false }
    },
    execute: async ({ command, args = '', confirmed = false }) => {
        const normalizedCmd = command.trim().toLowerCase()

        

        

        
        if (normalizedCmd === 'twitter' || normalizedCmd === 'x') {
            try {
                const summary = await downloadTwitterDirect(args)
                return `${summary}\nDO NOT rewrite these details, just give a short confirmation if needed.`
            } catch (e) {
                console.error('[run_plugin] Gagal download twitter (hard redirect):', e)
                return `Failed to download Twitter/X: ${e.message}`
            }
        }

        const MENU_LIKE_UNVERIFIED = ['help', 'allmenu', 'list']
        if (MENU_LIKE_UNVERIFIED.includes(normalizedCmd) && !ctx().isOwner) {

            

            let isSameAsMenu = false
            try {
                const { plugins } = await import('../../../utils/plugins.js')
                const resolve = (cmdStr) => {
                    for (const [name, p] of Object.entries(plugins || {})) {
                        if (!p || typeof p !== 'function' || !p.command) continue
                        const c = p.command
                        const match = c instanceof RegExp ? c.test(cmdStr)
                            : Array.isArray(c) ? c.some(x => x === cmdStr || (x instanceof RegExp && x.test(cmdStr)))
                            : c === cmdStr
                        if (match) return name
                    }
                    return null
                }
                const menuTarget = resolve('menu')
                const thisTarget = resolve(normalizedCmd)
                isSameAsMenu = !!menuTarget && menuTarget === thisTarget
            } catch (_) { }

            if (!isSameAsMenu) {
                return aiOnly(`Command "${command}" is not run automatically through the AI for non-owners — this plugin may display the list of owner commands. Just explain the bot features in your own words to the user, or ask the user to type ".${command}" directly.`)
            }
        }
        try {

            

            

            
            const { plugin: preCheckPlugin } = await resolvePlugin(command)
            const shouldSummarize = preCheckPlugin?.ai?.summarize === true

            const { pluginName, captured, risk: execRisk } = await execPluginCommand(command, args, { confirmed, captureOutput: shouldSummarize })

            
            
            const risk = execRisk || (preCheckPlugin ? classifyPluginRisk(pluginName, preCheckPlugin) : { level: 'none', reason: 'Risk unknown (fallback).' })

            if (!shouldSummarize) {

                
                const isDownloaderTag = Array.isArray(preCheckPlugin?.tags) && preCheckPlugin.tags.includes('downloader')
                if (isDownloaderTag) {

                    
                    
                    return `[STOP -- DO NOT CALL run_plugin AGAIN FOR THIS COMMAND/LINK]\nThe command ".${command}${args ? ' ' + args : ''}" (downloader) was already run ONCE and the plugin already sent its own reply to the user (usually a numbered list of choices when there are several formats/qualities, which CANNOT be completed through run_plugin). Your job here is DONE. DO NOT rewrite the plugin's reply, DO NOT call run_plugin again with the same command/link. If this platform is supported in download_media, use that tool to complete the download directly. If not, just remind the user ONCE to reply with the number of their choice directly in the chat -- then stay quiet, do not retry anything.`
                }
                return `Command ".${command}${args ? ' ' + args : ''}" finished running (internal risk: ${risk.level}, do NOT mention this term to the user). The plugin already sent its reply directly to the user -- DO NOT rewrite/add any other reply about this, just move on to something else if there is anything, or stay silent if there is nothing more to say.`
            }

            

            
            const conn = ctx().conn

            

            
            
            function digForText(obj, depth = 0) {
                if (!obj || typeof obj !== 'object' || depth > 4) return []
                let out = []
                for (const [key, val] of Object.entries(obj)) {
                    if (typeof val === 'string' && val.trim() && /text|caption/i.test(key)) {
                        out.push(val)
                    } else if (val && typeof val === 'object') {
                        out = out.concat(digForText(val, depth + 1))
                    }
                }
                return out
            }

            const textParts = []
            for (const msg of captured) {
                const c = msg.content || {}
                if (typeof c.text === 'string') {
                    textParts.push(c.text)
                } else if (typeof c.conversation === 'string') {
                    textParts.push(c.conversation)
                } else if (c.caption) {
                    textParts.push(c.caption)
                }

                
                if (msg.opts) {
                    for (const extra of digForText(msg.opts)) {
                        if (!textParts.includes(extra)) textParts.push(extra)
                    }
                }

                const isMediaOnly = c.image || c.video || c.document || c.audio || c.sticker
                if (isMediaOnly && conn) {
                    try { await conn.sendMessage(msg.jid, c, msg.opts) } catch (e) {
                        console.warn(`[run_plugin] Gagal kirim ulang media captured dari "${command}": ${e.message}`)
                    }
                }
            }

            const combinedOutput = textParts.filter(Boolean).join('\n\n')
            return aiOnly(`Command ".${command}${args ? ' ' + args : ''}" finished running (internal risk: ${risk.level}, do NOT mention this term to the user).\n\nRAW OUTPUT of the plugin (DO NOT forward/copy-paste it raw to the user, this is only DATA for you to read):\n${PLUGIN_OUT_START}\n${combinedOutput || '(the plugin did not send any text message)'}\n${PLUGIN_OUT_END}\n\nReply to the user in an ordinary natural conversational style matching your persona, AS SHORT AS POSSIBLE according to what the user actually asked/requested -- NOT a re-listing of all the fields above. Example: if the user only said "try ping", a natural answer is just something like "Pong! Response ~100ms." -- the RAM/CPU/disk/etc details above are only a reference for you, do NOT show them unless the user really asks about them (or you briefly offer "want to see the server details too?" without dumping everything right away).`)
        } catch (e) {
            return `${e.message}`
        }
    }
},
{
    name: 'check_plugin_risk',
    description: 'Check the risk level for the AI Agent (banned / high / medium / low / unclassified) of a command BEFORE running it through run_plugin — use this if you are unsure whether a command is safe to run automatically or needs confirmation/the owner first. This level limits the AI Agent, NOT the user (the user can still run any command manually in the chat). It does not run anything, it only checks.',
    parameters: {
        command: { type: 'string', description: 'The feature/command name to check, without prefix. Example: "broadcast", "ban", "sticker"', required: true }
    },
    execute: async ({ command }) => {
        try {
            const { plugins } = await import('../../../utils/plugins.js')
            let found = null, foundName = ''
            for (const [name, plugin] of Object.entries(plugins || {})) {
                if (!plugin || typeof plugin !== 'function' || !plugin.command) continue
                const cmd = plugin.command
                const isMatch = cmd instanceof RegExp ? cmd.test(command)
                    : Array.isArray(cmd) ? cmd.some(c => c === command || (c instanceof RegExp && c.test(command)))
                    : cmd === command
                if (isMatch) { found = plugin; foundName = name; break }
            }
            if (!found) return `Command "${command}" was not found. Check with list_plugins first for the correct command name.`
            const risk = classifyPluginRisk(foundName, found)
            const reqs = pluginRequirements(found)
            const ownerNote = risk.level === 'high' ? ' Level HIGH: only the owner may run this through the AI Agent, AND you must still ask for explicit confirmation first before run_plugin (confirmed: true) even if the requester is the owner.' : ''
            const bannedNote = risk.level === 'blocked' ? ' This is NOT a restriction on the user -- the user can still run this command manually by typing it directly in the chat. What is forbidden is the AI Agent running it through run_plugin.' : ''
            const noneNote = risk.level === 'none' ? ` Plugin file: ${foundName}. If the requester is the owner, read its source (read_file), then decide the fitting risk and write it back to this file (write_file) before running it -- see rule 6c.` : ''
            const reqNotes = [
                reqs.group ? 'can only be used in a group' : '',
                reqs.private ? 'can only be used in a DM/private chat' : '',
                reqs.premium ? 'needs premium status' : '',
                reqs.admin ? 'needs the sender to be a group admin' : '',
                reqs.botAdmin ? 'needs the bot to be a group admin' : '',
                reqs.limit ? 'uses a usage limit' : '',
            ].filter(Boolean)
            const reqLine = reqNotes.length ? `\nAdditional requirements: ${reqNotes.join(', ')}.` : ''
            const levelLabel = risk.level === 'blocked' ? 'BANNED' : risk.level.toUpperCase()
            return aiOnly(`Command "${command}" -> internal risk ${levelLabel} (source: ${risk.source || 'floor'}). ${risk.reason}${bannedNote}${ownerNote}${noneNote}${reqLine}\nNOTE: "${levelLabel}" is an internal term for you (the AI Agent) only -- NEVER mention this word or the word "risk" to the user, reply naturally (see rule 6c).`)
        } catch (e) {
            return `Failed to check the risk of command "${command}": ${e.message}`
        }
    }
},
{
    name: 'read_plugin_guide',
    description: 'Read the internal guide for creating a new plugin in this bot. Read this first before writing a new plugin.',
    parameters: {},
    execute: async () => {
        const guides = ['PLUGIN_GUIDE.md', 'PLUGIN_SHORTHAND.md', 'docs/plugin-guide.md', 'README.md']
        for (const g of guides) {
            const abs = path.join(ROOT, g)
            if (fs.existsSync(abs)) {
                const content = fs.readFileSync(abs, 'utf-8').slice(0, 6000)
                return `*${g}*\n\n${content}`
            }
        }

        return [
            '*This Bot\'s Plugin Guide* (built-in, there is no external PLUGIN_GUIDE.md)',
            '',
            '```js',
            "import axios from 'axios'",
            '',
            'let handler = async (m, { conn, text, args, usedPrefix, command }) => {',
            '    if (!text) throw `Example: ${usedPrefix + command} <input>`',
            '    // ...the plugin\'s main logic here...',
            '    await conn.reply(m.chat, "result", m)',
            '}',
            '',
            "handler.help = ['commandname <arg>']",
            "handler.tags = ['category']  // main, group, sticker, ai, internet, downloader, owner, etc",
            '',
            '// handler.command can be a regex OR an array of strings — both are valid:',
            "handler.command = /^(name|alias)$/i",
            "// OR: handler.command = ['name', 'alias']",
            '',
            'handler.limit = 1        // a NUMBER (limit cost per use), NOT boolean true/false',
            'handler.owner = false    // true = only regular owners can use it',
            'handler.rowner = false   // true = only the ROwner (root owner) can use it',
            'handler.group = false    // true = can only be used in a group',
            'handler.private = false  // true = can only be used in a private chat',
            'handler.admin = false    // true = only group admins can use it',
            'handler.register = false // true = the user MUST be registered first',
            'handler.level = 0        // minimum user level (from db.data.users[jid].level)',
            '',
            'export default handler',
            '```',
            '',
            '*Advanced patterns:*',
            '- `handler.before = async (m, { conn }) => {...}` — runs BEFORE all other plugins are checked, used for staged/stateful flows (e.g. a download plugin that waits for the user to pick a quality number after the link is sent — keep the state in `conn.someState[m.sender]` with timeout cleanup).',
            '- `handler.after = async (m, extra) => {...}` — runs AFTER the main handler finishes (success or error), used for cleanup.',
            '- A plugin that throws a plain string (`throw "error message"`) instead of an `Error` object is valid — the dispatcher catches it and shows it to the user as a message.',
            '- Use `import` ES modules, not `require()`, like the whole codebase.',
        ].join('\n')
    }
}
]
