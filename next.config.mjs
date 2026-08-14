// Origins the browser is actually asked to contact, derived from the code.
// Razorpay is reached by navigation only, so it needs form-action but no frame-src.
const CLERK = ['https://*.clerk.accounts.dev', 'https://*.clerk.com']
const CLERK_IMAGES = ['https://img.clerk.com', 'https://images.clerk.dev']
const TURNSTILE = ['https://challenges.cloudflare.com']
const IMAGEKIT = ['https://ik.imagekit.io']

const csp = [
    `default-src 'self'`,
    // Not optional: the App Router emits inline bootstrap and flight-data
    // scripts, and removing it needs nonce plumbing through the render path.
    `script-src 'self' 'unsafe-inline' ${[...CLERK, ...TURNSTILE].join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${[...IMAGEKIT, ...CLERK_IMAGES].join(' ')}`,
    `font-src 'self' data:`,
    `connect-src 'self' ${CLERK.join(' ')}`,
    `worker-src 'self' blob:`,
    `frame-src ${[...CLERK, ...TURNSTILE].join(' ')}`,
    `form-action 'self' https://rzp.io https://api.razorpay.com`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
].join('; ')

const securityHeaders = [
    // `preload` is deliberately omitted: it is a one-way commitment enforced
    // by browser vendors, not something to opt into from a config file.
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Alongside CSP frame-ancestors, for browsers honouring only one.
    { key: 'X-Frame-Options', value: 'DENY' },
    // Keeps full URLs, query strings included, off cross-origin requests.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

    // Enforced: this app is never framed, so it carries no breakage risk.
    { key: 'Content-Security-Policy', value: `frame-ancestors 'none'` },

    // Report-only until watched in a browser against a real Clerk tenant: a
    // missing origin in an enforced policy takes the storefront down. Provides
    // no protection until promoted to `Content-Security-Policy`.
    { key: 'Content-Security-Policy-Report-Only', value: csp },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
    images:{
        unoptimized: true
    },
    // Stops advertising the framework to anyone probing.
    poweredByHeader: false,
    async headers() {
        return [{ source: '/:path*', headers: securityHeaders }]
    },
};

export default nextConfig;
