#!/usr/bin/env node
// Validates .env before the app is ever started, so a missing or malformed
// credential fails here with a clear message instead of deep inside Next,
// Prisma or Clerk. Run with `npm run check`.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PLACEHOLDER = /^\s*$|-{3,}|xxx|your_|user:password@host|<.*>|placeholder/i

const loadEnv = () => {
    const file = resolve(ROOT, '.env')
    if (!existsSync(file)) return null
    const env = {}
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const i = t.indexOf('=')
        if (i === -1) continue
        env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    }
    return env
}

// `--production` promotes deferred variables to required, so a deploy cannot go
// out half-configured. Run it as the last gate before release.
const STRICT = process.argv.includes('--production')

// [key, required, matcher, hint], where required is true, false, or
// 'production' (optional locally, required under --production).
const CHECKS = [
    ['DATABASE_URL', true, /^postgres(ql)?:\/\/[^:]+:[^@]+@.+\/.+/, 'Neon pooled connection string'],
    ['DIRECT_URL', true, /^postgres(ql)?:\/\/[^:]+:[^@]+@.+\/.+/, 'Neon direct connection string'],
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', true, /^pk_(test|live)_/, 'starts with pk_test_ or pk_live_'],
    ['CLERK_SECRET_KEY', true, /^sk_(test|live)_/, 'starts with sk_test_ or sk_live_'],
    ['ADMIN_EMAIL', true, /^[^@\s,]+@[^@\s,]+\.[^@\s,]+/, 'must be the email you sign up with'],
    ['RAZORPAY_KEY_ID', true, /^rzp_(test|live)_/, 'starts with rzp_test_ or rzp_live_'],
    ['RAZORPAY_KEY_SECRET', true, /.+/, 'from Razorpay Dashboard -> Account & Settings -> API Keys'],
    ['IMAGEKIT_PUBLIC_KEY', true, /^public_/, 'starts with public_'],
    ['IMAGEKIT_PRIVATE_KEY', true, /^private_/, 'starts with private_'],
    ['IMAGEKIT_URL_ENDPOINT', true, /^https:\/\/ik\.imagekit\.io\/.+/, 'https://ik.imagekit.io/<your_id>'],
    ['INNGEST_EVENT_KEY', true, /.+/, 'from the Inngest dashboard'],
    ['INNGEST_SIGNING_KEY', true, /.+/, 'from the Inngest dashboard'],
    ['NEXT_PUBLIC_CURRENCY_SYMBOL', true, /.+/, 'e.g. $'],
    ['RAZORPAY_WEBHOOK_SECRET', 'production', /.+/, 'required to take online payments; online checkout is refused without it'],
    ['OPENAI_API_KEY', false, /.+/, 'optional — only powers AI product autofill'],
    ['OPENAI_BASE_URL', false, /^https?:\/\//, 'optional'],
    ['OPENAI_MODEL', false, /.+/, 'optional'],
]

const env = loadEnv()
if (!env) {
    console.error('\n  No .env file found.\n  Copy it with:  cp .env.example .env\n')
    process.exit(1)
}

const major = Number(process.versions.node.split('.')[0])
const rows = []
let failed = 0
let deferred = 0

for (const [key, required, matcher, hint] of CHECKS) {
    const raw = env[key] ?? ''
    const unset = !raw || PLACEHOLDER.test(raw)
    const mustHave = required === true || (required === 'production' && STRICT)

    if (unset) {
        if (mustHave) { rows.push(['MISSING', key, hint]); failed++ }
        else { rows.push(['SKIP', key, hint]); deferred++ }
        continue
    }
    if (!matcher.test(raw)) {
        rows.push([mustHave ? 'BAD' : 'BAD?', key, `expected: ${hint}`])
        if (mustHave) failed++
        continue
    }
    rows.push(['OK', key, ''])
}

const ICON = { OK: '  ok  ', MISSING: ' MISS ', BAD: ' BAD  ', 'BAD?': ' BAD? ', SKIP: ' skip ' }
console.log(`\n  Node ${process.versions.node}${major < 20 ? '   <-- Next 15 needs Node 20+' : ''}\n`)
for (const [state, key, note] of rows) {
    console.log(`  [${ICON[state]}] ${key.padEnd(36)} ${note}`)
}

if (failed) {
    console.error(`\n  ${failed} required variable(s) missing or malformed. Fill them in .env, then re-run: npm run check\n`)
    process.exit(1)
}

console.log(`\n  All required variables present${deferred ? ` (${deferred} optional/deferred skipped)` : ''}.`)

// Say what a deferred webhook secret costs, rather than a quiet `skip`.
if (!STRICT) {
    const secret = env.RAZORPAY_WEBHOOK_SECRET ?? ''
    if (!secret || PLACEHOLDER.test(secret)) {
        console.log('  Note: RAZORPAY_WEBHOOK_SECRET is unset, so online checkout will be refused')
        console.log('        (cash on delivery still works). Re-run with --production before release.')
    }
}

// Credentials look right; confirm the database is actually reachable.
try {
    process.env.DATABASE_URL = env.DATABASE_URL
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient()
    await prisma.$queryRaw`SELECT 1`
    const tables = await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
    await prisma.$disconnect()
    const n = tables[0].n
    console.log(`  Database reachable (${n} table${n === 1 ? '' : 's'} in public schema).`)
    if (n === 0) console.log('  Next:  npx prisma migrate deploy   then   npm run seed')
    else console.log('  Next:  npm run seed   then   npm run dev')
    console.log()
} catch (err) {
    console.error(`\n  Database unreachable: ${err.message.split('\n')[0]}`)
    console.error('  Check DATABASE_URL, and that the Neon project is not suspended.\n')
    process.exit(1)
}
