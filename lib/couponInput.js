// Builds a Coupon row from an untrusted body, or explains why it cannot.
// `discount` is bounded because it flows into the order total, where anything
// above 100 produces a negative order.
const MAX_CODE_LENGTH = 32
const MAX_DESCRIPTION_LENGTH = 200

export const parseCouponInput = (input, { now = new Date() } = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'missing coupon' }
    }

    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
    if (!code) return { error: 'coupon code is required' }
    if (code.length > MAX_CODE_LENGTH) return { error: 'coupon code is too long' }

    const description = typeof input.description === 'string' ? input.description.trim() : ''
    if (!description) return { error: 'coupon description is required' }
    if (description.length > MAX_DESCRIPTION_LENGTH) return { error: 'coupon description is too long' }

    const discount = typeof input.discount === 'number' ? input.discount : Number(input.discount)
    if (!Number.isFinite(discount) || discount <= 0 || discount > 100) {
        return { error: 'discount must be greater than 0 and at most 100' }
    }

    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
    if (Number.isNaN(expiresAt.getTime())) return { error: 'expiry date is invalid' }
    if (expiresAt <= now) return { error: 'expiry date must be in the future' }

    // Absent or blank means unlimited; one use per shopper applies either way.
    let maxRedemptions = null
    if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && input.maxRedemptions !== '') {
        maxRedemptions = Number(input.maxRedemptions)
        if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
            return { error: 'redemption limit must be a whole number of at least 1' }
        }
    }

    // Allowlisted: nothing the caller invents is written, and `createdAt` stays
    // the database's to decide.
    return {
        coupon: {
            code,
            description,
            discount,
            forNewUser: Boolean(input.forNewUser),
            forMember: Boolean(input.forMember),
            isPublic: Boolean(input.isPublic),
            expiresAt,
            maxRedemptions,
        },
    }
}

export default parseCouponInput
