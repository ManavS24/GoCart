import { describeError, logger } from "@/lib/logger"
import { clerkClient } from "@clerk/nextjs/server"


const authAdmin = async (userId) => {
    try {
        if(!userId) return false

        const adminEmails = (process.env.ADMIN_EMAIL || '')
            .split(',')
            .map(email => email.trim().toLowerCase())
            .filter(Boolean)

        if(!adminEmails.length) return false

        const client = await clerkClient()
        const user = await client.users.getUser(userId)

        // The primary address, and only once Clerk has confirmed ownership.
        // `emailAddresses[0]` trusted array order for an authorization decision
        // and accepted an address whose ownership was never proven.
        const primary = user.emailAddresses?.find(
            address => address.id === user.primaryEmailAddressId
        )

        if (primary?.verification?.status !== 'verified') return false

        const email = primary.emailAddress?.toLowerCase()

        return Boolean(email) && adminEmails.includes(email)
    } catch (error) {
        logger.error('auth_admin_failed', describeError(error))
        return false
    }
}

export default authAdmin