import { createHmac, timingSafeEqual } from 'crypto'

// Razorpay signs the raw body with HMAC-SHA256 and sends the hex digest in
// x-razorpay-signature.
//
// Not the SDK's own validateWebhookSignature: that compares with `===`, which
// leaks the digest a byte at a time, and throws when the header is absent
// rather than reporting an unverified request.
export const verifyWebhookSignature = (rawBody, signature, secret) => {
    if (typeof rawBody !== 'string' || !signature || !secret) return false

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')

    // timingSafeEqual throws on a length mismatch, which is itself the answer.
    if (signature.length !== expected.length) return false

    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

export default verifyWebhookSignature
