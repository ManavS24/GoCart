import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

// Without this Next evaluates the handler at build time: a health check
// answered from the build, and a build that needs a live database.
export const dynamic = 'force-dynamic'

// A probe that hangs tells you nothing: the monitor just times out.
const DB_TIMEOUT_MS = 5000

export async function GET() {
    const startedAt = Date.now()

    let database = 'down'
    let timer

    try {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('database check timed out')), DB_TIMEOUT_MS)
            }),
        ])
        database = 'up'
    } catch (error) {
        // Logged, never returned: Prisma puts the connection target in the message.
        logger.error('health_database_unreachable', { message: error?.message })
    } finally {
        clearTimeout(timer)
    }

    const healthy = database === 'up'

    return NextResponse.json(
        {
            status: healthy ? 'ok' : 'degraded',
            database,
            // Which deploy is serving. Unset outside Vercel.
            version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown',
            latencyMs: Date.now() - startedAt,
        },
        {
            // 503 so a monitor can act without parsing the body.
            status: healthy ? 200 : 503,
            headers: { 'Cache-Control': 'no-store' },
        }
    )
}
