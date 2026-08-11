import { describeError, logger } from '@/lib/logger'
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

        // Approved *and* switched on: a deactivated store is not trading.
        if (user?.store?.status === 'approved' && user.store.isActive === true) {
            return user.store.id
        }

        return false
    } catch (error) {
        logger.error('auth_seller_failed', describeError(error))
        return false
    }
}

export default authSeller
