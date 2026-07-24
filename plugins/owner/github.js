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

        // Remove puppeteer cache so it doesn't get pushed to GitHub
        const cacheDir = path.join(ROOT, '.cache')

        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, {
                recursive: true,
                force: true
            })
        }

        const gitignorePath = path.join(ROOT, '.gitignore')

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
            '*.zip',
            '*.tar.gz',
            '*.log',
            'package-lock.json',
            'yarn.lock',
            'pnpm-lock.json',
            '.npmrc',
        ]

        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(
                gitignorePath,
                ignoreRules.join('\n')
            )
        } else {
            let content = fs.readFileSync(
                gitignorePath,
                'utf8'
            )

            for (const rule of ignoreRules) {
                if (!content.includes(rule)) {
                    content += '\n' + rule
                }
            }

            fs.writeFileSync(gitignorePath, content)
        }

        const remoteUrl =
            `https://${user}:${token}@github.com/${user}/${repo}.git`

        try {
            await execAsync('git init', {
                cwd: ROOT
            })
        } catch {}

        await execAsync(
            `git config user.email "${email}"`,
            { cwd: ROOT }
        )

        await execAsync(
            `git config user.name "${user}"`,
            { cwd: ROOT }
        )

        try {
            await execAsync(
                'git remote remove origin',
                { cwd: ROOT }
            )
        } catch {}

        await execAsync(
            `git remote add origin "${remoteUrl}"`,
            { cwd: ROOT }
        )

        // Remove cache from git index if it was ever accidentally committed
        try {
            await execAsync(
                'git rm -r --cached .cache',
                { cwd: ROOT }
            )
        } catch {}

        try {
            await execAsync(
                'git rm -r --cached node_modules',
                { cwd: ROOT }
            )
        } catch {}

        await execAsync('git add .', {
            cwd: ROOT
        })

        const { stdout: status } =
            await execAsync(
                'git status --porcelain',
                { cwd: ROOT }
            )

        if (!status.trim()) {
            await conn.reply(m.chat, '✅ Nothing to upload, no changes detected.', m)
            m.react('✅')
            return
        }

        try {
            await execAsync(
                `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
                { cwd: ROOT }
            )
        } catch {}

        await execAsync(
            'git branch -M main',
            { cwd: ROOT }
        )

        await execAsync(
            'git push -u origin main --force',
            { cwd: ROOT }
        )

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
        // 1. Check current branch
        const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT })

        // 2. Check short status
        const { stdout: statusShort } = await execAsync('git status --short', { cwd: ROOT })

        // 3. Check whether there are commits not yet pushed
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

handler.dym = ['gitpush', 'gitstats']
handler.help = ['gitpush <commit message>', 'gitstats']
handler.tags = ['owner']
handler.command = /^(gitpush|gitstats)$/i
handler.rowner = true
handler.ai = { risk: 'low', isTool:true, summarize: true, description: "Push project to github repository" }

export default handler