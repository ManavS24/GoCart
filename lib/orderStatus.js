import { OrderStatus } from '@prisma/client'

// Fulfilment only moves forward. Skipping ahead is allowed; going back is not.
export const ORDER_STATUS_SEQUENCE = [
    OrderStatus.ORDER_PLACED,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
]

// Returns the status with every status it may be reached from, so the rule can
// live in the update's `where` rather than in a read-then-write.
export const parseOrderStatus = (value) => {
    if (typeof value !== 'string') {
        return { error: 'invalid order status' }
    }

    const index = ORDER_STATUS_SEQUENCE.indexOf(value)
    if (index === -1) {
        return { error: 'invalid order status' }
    }

    return {
        status: value,
        // Inclusive of the target itself, so re-sending the current status is a
        // harmless no-op rather than an error a double-click would produce.
        reachableFrom: ORDER_STATUS_SEQUENCE.slice(0, index + 1),
    }
}

export default parseOrderStatus
