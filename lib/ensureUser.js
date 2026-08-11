import { clerkClient } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

// Guarantees the User row an authenticated write depends on: the Inngest
// handler that mirrors Clerk may lag a first sign-in or never be configured.
// Reads do not call this -- they treat a missing row as normal.
export const ensureUser = async (userId) => {
    if (!userId) return false

    // The common case: one indexed lookup, no Clerk round trip.
    const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, image: true },
    })

    // Repairs an obvious placeholder if the `clerk/user.updated` sync is not
    // wired. A complete row is left alone: the sync owns updates.
    if (existing) {
        const looksPlaceholder = !existing.email || !existing.name
            || existing.name === existing.id || existing.name === 'null null'
        if (!looksPlaceholder) return true
    }

    const client = await clerkClient()
    const user = await client.users.getUser(userId)

    const email = user?.emailAddresses?.[0]?.emailAddress ?? ''
    // Falls back rather than writing "null null" from absent Clerk fields.
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ')
        || user?.username || email || userId

    const data = { name, email, image: user?.imageUrl ?? '' }

    try {
        if (existing) {
            // Repairing a placeholder, not overwriting a synced row -- and never
            // touching `cart`, which is the shopper's, not Clerk's.
            await prisma.user.update({ where: { id: userId }, data })
        } else {
            await prisma.user.create({ data: { id: userId, ...data } })
        }
    } catch (error) {
        // The Inngest sync or a concurrent request created it first. Both leave
        // exactly the row this call exists to guarantee, so that is success.
        if (error.code !== 'P2002') throw error
    }

    return true
}

export default ensureUser
