// Resolves an untrusted value to a path inside this app, or null. Anything that
// could leave the origin is rejected outright rather than sanitised.
export const safeInternalPath = (value) => {
    if (typeof value !== 'string') return null

    const trimmed = value.trim()
    if (!trimmed) return null

    // Unreserved path characters only, so no scheme or host form can match.
    if (!/^\/?[A-Za-z0-9\-_]+(?:\/[A-Za-z0-9\-_]+)*\/?$/.test(trimmed)) return null

    return `/${trimmed.replace(/^\/+/, '')}`
}

export default safeInternalPath
