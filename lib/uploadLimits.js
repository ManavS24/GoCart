// Ceilings on what one request may cost. Rate limiting bounds how often a caller
// can spend; these bound how much a single call can.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024        // 5 MB per image
export const MAX_IMAGES_PER_PRODUCT = 8

// An allowlist, so an unexpected type is refused rather than forwarded.
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// Estimated from the encoding, not decoded: decoding to measure would allocate
// exactly the memory the cap exists to avoid.
export const base64Bytes = (value) =>
    typeof value === 'string' ? Math.floor((value.length * 3) / 4) : 0

export const isAllowedImageType = (mimeType) =>
    typeof mimeType === 'string' && ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase())

// `mimeType` and `File.type` are strings the client chose; these are not.
const SIGNATURES = [
    { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },          // \x89PNG
    { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },          // GIF8
    { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },         // RIFF
]

export const sniffImageType = (bytes) => {
    // JPEG's signature is three bytes; requiring four would miss it.
    if (!bytes || bytes.length < 3) return null
    for (const { type, bytes: signature } of SIGNATURES) {
        if (signature.every((byte, i) => bytes[i] === byte)) return type
    }
    return null
}

// A declared type is honoured only if the bytes agree.
export const bytesMatchClaimedType = (bytes, mimeType) => {
    const actual = sniffImageType(bytes)
    if (!actual) return false
    return actual === String(mimeType || '').toLowerCase()
}
