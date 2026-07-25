import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { neonConfig } from '@neondatabase/serverless';

import ws from 'ws';
neonConfig.webSocketConstructor = ws;

// Required to query over fetch in edge runtimes.
neonConfig.poolQueryViaFetch = true

const isEdge = process.env.NEXT_RUNTIME === 'edge'

const createClient = () => {
    if (!isEdge) {
        return new PrismaClient()
    }

    // Otherwise the adapter receives the literal string "undefined".
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set')
    }

    return new PrismaClient({
        adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }),
    })
}

// Reused across hot reloads so dev does not exhaust connections.
const prisma = global.prisma || createClient()

if (!isEdge) global.prisma = prisma;

export default prisma;
