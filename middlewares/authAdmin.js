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

        const email = user.emailAddresses[0]?.emailAddress?.toLowerCase()

        return Boolean(email) && adminEmails.includes(email)
    } catch (error) {
        console.error(error)
        return false
    }
}

export default authAdmin