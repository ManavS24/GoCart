import { PaymentMethod } from '@prisma/client'
import { ONLINE_PAYMENT_METHODS } from '@/lib/onlinePayment'

// What counts as a real order: COD on placement, an online method only once
// paid. Spread into the `where` of every query that reads orders, so no two
// can disagree.
export const PLACED_ORDER = {
    OR: [
        { paymentMethod: PaymentMethod.COD },
        { AND: [{ paymentMethod: { in: ONLINE_PAYMENT_METHODS } }, { isPaid: true }] },
    ],
}

export default PLACED_ORDER
