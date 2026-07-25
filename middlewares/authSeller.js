import prisma from '@/lib/prisma';

// Returns the approved store's id, or false for every other case — never
// undefined, which Prisma would silently drop from a `where` clause.
const authSeller = async (userId) => {
    try {
        if (!userId) return false

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { store: true },
        })

        if (user?.store?.status === 'approved') {
            return user.store.id
        }

        return false
    } catch (error) {
        console.error(error)
        return false
    }
}

export default authSeller
