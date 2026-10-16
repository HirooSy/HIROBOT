import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const execAsync = promisify(exec)

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const ROOT       = path.join(__dirname, '../../')

let handler = async (m, { conn, args, command }) => {
    if (command === 'gitpush') {
        await pushToGitHub(conn, m, args)
    } else {
        await checkGitHubStatus(conn, m)
    }
}

async function pushToGitHub(conn, m, args) {
    const commitMessage =
        args.length > 0
            ? args.join(' ')
            : '✦'

    m.react('⬆️')

    try {
        const token = process.env.GIT_TOKEN
        const user  = process.env.GIT_USER
        const email = process.env.GIT_EMAIL
        const repo  = process.env.GIT_REPO

        if (!token || !user || !email || !repo) {
            throw new Error(
                'GIT_TOKEN, GIT_USER, GIT_EMAIL, or GIT_REPO is not set'
            )
        }

        const cacheDir = path.join(ROOT, '.cache')

        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, {
                recursive: true,
                force: true
            })
        }

        const ignoreRules = [
            '.cache/',
            '.gitignore',
            'node_modules/',
            '.env',
            'data/',
            '*.log',
            '*.zip',
            '*.bin',
            '*.pid',
            '*.bak',
            '.git',
            '*.tar.gz',
            'package-lock.json',
            'yarn.lock',
            'pnpm-lock.json',
            '.npmrc',
            '.npm',
            'replit.nix',
            '.replit',
            'run.js',
            '.github/*',
            '!.github/workflows/',
            '.github/workflows/*',
            '!.github/workflows/uptimer.yml',
            '!.github/FUNDING.yml',
        ]

        try {
            await execAsync('git init', { cwd: ROOT })
        } catch {}

        const excludePath = path.join(ROOT, '.git', 'info', 'exclude')
        fs.mkdirSync(path.dirname(excludePath), { recursive: true })
        fs.writeFileSync(excludePath, ignoreRules.join('\n') + '\n')

        const remoteUrl =
            `https://${user}:${token}@github.com/${user}/${repo}.git`

        await execAsync(
            `git config user.email "${email}"`,
            { cwd: ROOT }
        )

        await execAsync(
            `git config user.name "${user}"`,
            { cwd: ROOT }
        )

        const commitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: user,
            GIT_AUTHOR_EMAIL: email
        }

        try {
            await execAsync('git remote remove origin', { cwd: ROOT })
        } catch {}

        await execAsync(
            `git remote add origin "${remoteUrl}"`,
            { cwd: ROOT }
        )

        const untrackTargets = [
            '.cache',
            'node_modules',
            '.github',
            '.gitignore',
            '.env',
            'data',
            'run.js',
        ]

        for (const target of untrackTargets) {
            try {
                await execAsync(
                    `git rm -r --cached --ignore-unmatch "${target}"`,
                    { cwd: ROOT }
                )
            } catch {}
        }

        await execAsync('git add .', { cwd: ROOT })

        const whitelistFiles = [
            '.github/FUNDING.yml',
            '.github/workflows/uptimer.yml',
        ]

        for (const file of whitelistFiles) {
            const fullPath = path.join(ROOT, file)
            if (fs.existsSync(fullPath)) {
                try {
                    await execAsync(
                        `git add -f "${file}"`,
                        { cwd: ROOT }
                    )
                } catch (e) {
                    console.error(`[gitpush] Failed to force-add ${file}:`, e.message)
                }
            }
        }

        const { stdout: status } =
            await execAsync('git status --porcelain', { cwd: ROOT })

        if (!status.trim()) {
            await conn.reply(m.chat, '✅ Nothing to upload, no changes detected.', m)
            m.react('✅')
            return
        }

        try {
            await execAsync(
                `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
                { cwd: ROOT, env: commitEnv }
            )
        } catch {}

        await execAsync('git branch -M main', { cwd: ROOT })

        await execAsync('git push -u origin main --force', { cwd: ROOT })

        await conn.reply(
            m.chat,
            `✅ Successfully uploaded to GitHub!\n\n` +
            `- *Repo:* ${repo}\n` +
            `- *Commit:* ${commitMessage}\n` +
            `- *Branch:* main`,
            m
        )

        m.react('✅')

    } catch (error) {
        console.error(error)
        await conn.reply(m.chat, `❌ Upload failed:\n\n${error.message}`, m)
        m.react('❌')
    }
}

async function checkGitHubStatus(conn, m) {
    m.react('🔍')

    try {
        const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT })
        const { stdout: statusShort } = await execAsync('git status --short', { cwd: ROOT })
        const { stdout: statusBranch } = await execAsync('git status -sb', { cwd: ROOT })
        const isAhead = statusBranch.includes('ahead')

        let response = `*GitHub Repository Status*\n\n`
        response += `- *Branch:* \`${branch.trim()}\`\n`

        if (!statusShort) {
            response += `- *Status:* Working directory clean. (No changes)\n`
        } else {
            response += `- *Status:* There are uncommitted changes:\n`
            response += `\`\`\`\n${statusShort.trim()}\n\`\`\`\n`
        }

        if (isAhead) {
            response += `- *Sync:* There are commits not yet pushed to remote.\n`
            response += `Use \`.gitpush\` to upload.`
        } else {
            response += `- *Sync:* Up-to-date with remote.`
        }

        await conn.reply(m.chat, response, m)
        m.react('✅')

    } catch (error) {
        console.error('[gitstats] Error:', error)
        await conn.reply(m.chat, `❌ Failed to check GitHub status: ${error.message}`, m)
        m.react('❌')
    }
}

handler.help = ['gitpush <commit message>', 'gitstats']
handler.tags = ['owner']
handler.command = /^(gitpush|gitstats)$/i
handler.rowner = true
handler.ai = { risk: 'low', summarize: true, description: "Push project to github repository" }

export default handler