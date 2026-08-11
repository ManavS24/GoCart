// A per-caller budget held in this instance's memory. NOT a shared limiter: a
// caller spread across N warm instances gets N times the budget, and a cold
// start forgets everything. A floor, not a guarantee.

const buckets = new Map()

// Sweep only once the map is large enough to be worth sweeping.
const PRUNE_THRESHOLD = 5000

const prune = (now) => {
    if (buckets.size < PRUNE_THRESHOLD) return
    const stale = Math.floor(now / 60_000) * 60_000 - 120_000
    for (const [key, bucket] of buckets) {
        if (bucket.windowStart < stale) buckets.delete(key)
    }
}

// Sliding window: a fixed one lets a caller spend the whole budget either side
// of a boundary. Weighting the previous window by its remaining overlap smooths
// that out without keeping a timestamp per request.
export const rateLimit = ({ key, limit, windowMs, now = Date.now() }) => {
    const bucket = buckets.get(key)
    const windowStart = Math.floor(now / windowMs) * windowMs

    if (!bucket || bucket.windowStart < windowStart - windowMs) {
        prune(now)
        buckets.set(key, { windowStart, count: 1, previous: 0 })
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 }
    }

    if (bucket.windowStart < windowStart) {
        bucket.previous = bucket.count
        bucket.count = 0
        bucket.windowStart = windowStart
    }

    const elapsed = (now - windowStart) / windowMs
    const estimated = bucket.previous * (1 - elapsed) + bucket.count

    if (estimated >= limit) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
        }
    }

    bucket.count += 1
    return {
        allowed: true,
        remaining: Math.max(0, Math.floor(limit - estimated - 1)),
        retryAfterSeconds: 0,
    }
}

export const __resetRateLimits = () => buckets.clear()

export default rateLimit

// Falls back to one shared bucket: a caller who cannot be told apart shares a
// budget rather than escaping one.
export const callerIp = (request) => {
    const forwarded = request?.headers?.get?.('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()
    return request?.headers?.get?.('x-real-ip') || 'unknown'
}
