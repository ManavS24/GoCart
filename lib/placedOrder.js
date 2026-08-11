import { PaymentMethod } from '@prisma/client'

// What counts as a real order: COD on placement, Stripe only once paid. Spread
// into the `where` of every query that reads orders, so no two can disagree.
export const PLACED_ORDER = {
    OR: [
        { paymentMethod: PaymentMethod.COD },
        { AND: [{ paymentMethod: PaymentMethod.STRIPE }, { isPaid: true }] },
    ],
}

export default PLACED_ORDER
