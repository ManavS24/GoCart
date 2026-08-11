// A cart is a flat map of product id to quantity, and nothing else. Without
// this the `cart` JSONB column accepts arbitrary JSON of any size.

export const MAX_CART_ITEMS = 100
export const MAX_ID_LENGTH = 64
export const MAX_QUANTITY = 999

// Advisory: a client can omit or fake `Content-Length`. Cheap refusal for the
// honest case; the platform's request limit is the real ceiling.
export const MAX_BODY_BYTES = 128 * 1024

export const bodyTooLarge = (request) => {
    const declared = Number(request?.headers?.get?.('content-length'))
    return Number.isFinite(declared) && declared > MAX_BODY_BYTES
}

export const parseCartInput = (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'cart must be an object' }
    }

    const entries = Object.entries(input)
    if (entries.length > MAX_CART_ITEMS) {
        return { error: `a cart cannot hold more than ${MAX_CART_ITEMS} products` }
    }

    const cart = {}

    for (const [productId, quantity] of entries) {
        if (typeof productId !== 'string' || !productId || productId.length > MAX_ID_LENGTH) {
            return { error: 'cart contains an invalid product id' }
        }
        // Rejected rather than coerced: guessing would write nonsense.
        if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
            return { error: 'cart quantities must be whole numbers' }
        }
        if (quantity < 1 || quantity > MAX_QUANTITY) {
            return { error: `cart quantities must be between 1 and ${MAX_QUANTITY}` }
        }
        cart[productId] = quantity
    }

    return { cart }
}

export default parseCartInput
