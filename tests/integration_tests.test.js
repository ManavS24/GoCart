// Modules wired together. Only external boundaries are mocked (Prisma, Clerk,
// Razorpay, ImageKit, OpenAI, Inngest); real middleware and route handlers run.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    store: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    product: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    order: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    rating: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    address: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    coupon: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    processedWebhookEvent: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    checkoutRequest: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}
// The callback runs against the same double, so a statement issued through `tx`
// records on its own model mock. `txCommit` marks the instant the callback
// returned, distinguishing "inside the transaction" from "just after it".
// The health check's liveness probe.
prisma.$queryRaw = vi.fn()

const txCommit = vi.fn()
prisma.$transaction = vi.fn(async (fn) => {
    const result = await fn(prisma)
    txCommit()
    return result
})
const getAuth = vi.fn()
const clerkGetUser = vi.fn()
const razorpayCreateLink = vi.fn()
const razorpayListLinks = vi.fn()
const imagekitUpload = vi.fn()
const inngestSend = vi.fn()
const openaiCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({ default: prisma }))
vi.mock('@clerk/nextjs/server', () => ({
    getAuth: (...a) => getAuth(...a),
    clerkClient: async () => ({ users: { getUser: (...a) => clerkGetUser(...a) } }),
}))
vi.mock('razorpay', () => {
    function FakeRazorpay() {
        const self = this instanceof FakeRazorpay ? this : Object.create(FakeRazorpay.prototype)
        self.paymentLink = {
            create: (...a) => razorpayCreateLink(...a),
            all: (...a) => razorpayListLinks(...a),
        }
        return self
    }
    return { default: FakeRazorpay }
})
vi.mock('@/configs/imageKit', () => ({
    default: () => ({ upload: (...a) => imagekitUpload(...a), url: () => 'https://ik.test/img.webp' }),
}))
vi.mock('@/configs/openai', () => ({
    getOpenAI: () => ({ chat: { completions: { create: (...a) => openaiCreate(...a) } } }),
}))
// `createFunction` returns the pieces rather than registering anything, so a
// scheduled job can be invoked directly and its handler tested like any other.
vi.mock('@/inngest/client', () => ({
    inngest: {
        send: (...a) => inngestSend(...a),
        createFunction: (config, trigger, handler) => ({ config, trigger, handler }),
    },
}))

const orders = await import('@/app/api/orders/route')
const cartApi = await import('@/app/api/cart/route')
const addressApi = await import('@/app/api/address/route')
const couponApi = await import('@/app/api/coupon/route')
const ratingApi = await import('@/app/api/rating/route')
const productsApi = await import('@/app/api/products/route')
const storeCreate = await import('@/app/api/store/create/route')
const storeProduct = await import('@/app/api/store/product/route')
const storeDashboard = await import('@/app/api/store/dashboard/route')
const storeOrders = await import('@/app/api/store/orders/route')
const storeData = await import('@/app/api/store/data/route')
const storeIsSeller = await import('@/app/api/store/is-seller/route')
const storeStock = await import('@/app/api/store/stock-toggle/route')
const storeAi = await import('@/app/api/store/ai/route')
const adminApprove = await import('@/app/api/admin/approve-store/route')
const adminStores = await import('@/app/api/admin/stores/route')
const adminToggle = await import('@/app/api/admin/toggle-store/route')
const adminCoupon = await import('@/app/api/admin/coupon/route')
const adminDashboard = await import('@/app/api/admin/dashboard/route')
const adminIsAdmin = await import('@/app/api/admin/is-admin/route')
const healthApi = await import('@/app/api/health/route')
const productById = await import('@/app/api/products/[productId]/route')
const { PLACED_ORDER } = await import('@/lib/placedOrder')
const { SELLABLE_STORE } = await import('@/lib/sellableStore')
const { __resetRateLimits } = await import('@/lib/rateLimit')
const { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PRODUCT } = await import('@/lib/uploadLimits')
const jobs = await import('@/inngest/functions')

const { readdirSync, readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const API_ROOT = fileURLToPath(new URL('../app/api', import.meta.url))

// Walks app/api rather than trusting a hand-written list, so a new endpoint is
// covered the moment it exists.
const routeFiles = (dir = API_ROOT, route = '/api', out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) routeFiles(`${dir}/${entry.name}`, `${route}/${entry.name}`, out)
        else if (entry.name === 'route.js') out.push({ route, file: `${dir}/${entry.name}` })
    }
    return out
}

const ORIGIN = 'https://shop.test'
const json = (body) => ({
    json: async () => body,
    headers: new Headers({ origin: ORIGIN }),
    nextUrl: new URL(ORIGIN),
    url: ORIGIN,
})
const url = (u) => ({ url: u, nextUrl: new URL(u), headers: new Headers() })
const form = (fields) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) {
        Array.isArray(v) ? v.forEach(x => fd.append(k, x)) : fd.append(k, v)
    }
    return { formData: async () => fd, headers: new Headers() }
}
const read = async (res) => ({ status: res.status, body: await res.json() })
// A real PNG signature, not a placeholder byte: the upload path now checks that
// the bytes match the type the caller claims.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = 'iVBORw0KGgo='
const png = (n = 'a.png') => new File([PNG_BYTES], n, { type: 'image/png' })

// A signed-in shopper normally already has their mirrored User row; tests that
// care about it being absent override this afterwards.
const asShopper = (userId = 'u1', plus = false) => {
    getAuth.mockReturnValue({ userId, has: () => plus })
    // A complete row: `name` and `email` are NOT NULL in the schema, so a row
    // missing them is a placeholder ensureUser will repair.
    prisma.user.findUnique.mockResolvedValue({
        id: userId, name: 'Test Shopper', email: `${userId}@example.com`, image: '',
    })
}
// Drives the real authSeller via the mocked user row.
const asSeller = (status = 'approved', storeId = 'store_1', userId = 'u1', isActive = true) => {
    getAuth.mockReturnValue({ userId, has: () => false })
    prisma.user.findUnique.mockResolvedValue({
        id: userId, name: 'Test Seller', email: `${userId}@example.com`, image: '',
        store: { id: storeId, status, isActive },
    })
}
// Drives the real authAdmin against ADMIN_EMAIL.
const asAdmin = (email = 'admin@example.com') => {
    getAuth.mockReturnValue({ userId: 'admin_1', has: () => false })
    // Shaped as the Clerk Backend API returns it: the primary address is named
    // by id, and carries a verification record.
    clerkGetUser.mockResolvedValue({
        primaryEmailAddressId: 'idn_primary',
        emailAddresses: [
            { id: 'idn_primary', emailAddress: email, verification: { status: 'verified' } },
        ],
    })
}
const anonymous = () => getAuth.mockReturnValue({ userId: null, has: () => false })

// Model methods actually invoked, for "did this leak?" assertions.
// `$transaction` is a bare function, not a model, so it is skipped here.
const readsPerformed = () =>
    Object.entries(prisma).flatMap(([model, methods]) =>
        typeof methods !== 'object' || methods === null ? [] :
        Object.entries(methods).filter(([, fn]) => fn.mock.calls.length > 0).map(([m]) => `${model}.${m}`))

beforeEach(() => {
    vi.clearAllMocks()
    // The limiter's counters live in module state, not in a mock.
    __resetRateLimits()
    // `clearAllMocks` keeps implementations, so a value set by one test leaks
    // into the next. Reset to "found nothing"; tests override what they need.
    prisma.order.findFirst.mockResolvedValue(null)
    prisma.orderStatusChange = { create: vi.fn().mockResolvedValue({}) }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ADMIN_EMAIL = 'admin@example.com'
    // A correctly configured deployment has these; online checkout is refused
    // without them, so tests for that case delete them explicitly.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x'
    process.env.RAZORPAY_KEY_SECRET = 'secret'
})

describe('integration: anonymous callers are refused everywhere', () => {
    const endpoints = [
        ['POST /api/orders', () => orders.POST(json({ addressId: 'a', items: [{ id: 'p', quantity: 1 }], paymentMethod: 'COD' }))],
        ['POST /api/cart', () => cartApi.POST(json({ cart: {} }))],
        ['GET  /api/cart', () => cartApi.GET(url(`${ORIGIN}/api/cart`))],
        ['POST /api/address', () => addressApi.POST(json({ address: { name: 'x' } }))],
        ['GET  /api/address', () => addressApi.GET(url(`${ORIGIN}/api/address`))],
        ['POST /api/coupon', () => couponApi.POST(json({ code: 'NEW20' }))],
        ['POST /api/rating', () => ratingApi.POST(json({ orderId: 'o', productId: 'p', rating: 5, review: 'ok' }))],
        ['GET  /api/rating', () => ratingApi.GET(url(`${ORIGIN}/api/rating`))],
        ['POST /api/store/create', () => storeCreate.POST(form({ name: 'S' }))],
        ['GET  /api/store/create', () => storeCreate.GET(url(`${ORIGIN}/api/store/create`))],
    ]

    // The list above is hand-maintained, and `GET /api/orders` was never added
    // to it -- which is how it shipped with no guard. These walk app/api instead.
    const ROUTE_MODULES = {
        '/api/address': addressApi,
        '/api/admin/approve-store': adminApprove,
        '/api/admin/coupon': adminCoupon,
        '/api/admin/dashboard': adminDashboard,
        '/api/admin/is-admin': adminIsAdmin,
        '/api/admin/stores': adminStores,
        '/api/admin/toggle-store': adminToggle,
        '/api/cart': cartApi,
        '/api/coupon': couponApi,
        '/api/health': healthApi,
        '/api/orders': orders,
        '/api/products': productsApi,
        '/api/products/[productId]': productById,
        '/api/rating': ratingApi,
        '/api/store/ai': storeAi,
        '/api/store/create': storeCreate,
        '/api/store/dashboard': storeDashboard,
        '/api/store/data': storeData,
        '/api/store/is-seller': storeIsSeller,
        '/api/store/orders': storeOrders,
        '/api/store/product': storeProduct,
        '/api/store/stock-toggle': storeStock,
    }

    // Endpoints that are meant to answer an anonymous caller, each with the
    // reason it is safe to do so.
    const PUBLIC = {
        '/api/products GET': 'the storefront catalogue',
        '/api/products/[productId] GET': 'a public product page',
        '/api/store/data GET': 'a public store page',
        '/api/health GET': 'a liveness probe, which must answer before anyone is signed in',
    }
    // Every guarded endpoint now authenticates before reading its body, so there
    // are no exceptions left.
    const NON_401 = {}

    // Satisfies every body shape the handlers reach for.
    const anyRequest = (u) => ({
        json: async () => ({}),
        text: async () => '{}',
        formData: async () => new FormData(),
        headers: new Headers({ origin: ORIGIN }),
        nextUrl: new URL(u),
        url: u,
    })

    it('registers every route module that exists on disk', () => {
        // Inngest mounts its own signed handler and is excluded deliberately.
        const expected = routeFiles().map(r => r.route).filter(r => r !== '/api/inngest').sort()
        expect(Object.keys(ROUTE_MODULES).sort()).toEqual(expected)
    })

    for (const [route, mod] of Object.entries(ROUTE_MODULES)) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
            if (typeof mod[method] !== 'function') continue
            const key = `${route} ${method}`
            if (PUBLIC[key]) continue

            it(`${method} ${route} refuses an anonymous caller and reaches no data`, async () => {
                anonymous()
                const res = await mod[method](anyRequest(`${ORIGIN}${route}`))
                expect(res.status).toBe(NON_401[key] ?? 401)
                expect(readsPerformed()).toEqual([])
            })
        }
    }

    for (const [label, call] of endpoints) {
        it(`${label} returns 401 and touches no table`, async () => {
            anonymous()
            const { status } = await read(await call())
            expect(status).toBe(401)
            expect(readsPerformed()).toEqual([])
        })
    }
})

describe('integration: seller endpoints reject non-approved stores', () => {
    const endpoints = [
        ['GET  /api/store/dashboard', () => storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`))],
        ['GET  /api/store/orders', () => storeOrders.GET(url(`${ORIGIN}/api/store/orders`))],
        ['POST /api/store/orders', () => storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))],
        ['GET  /api/store/product', () => storeProduct.GET(url(`${ORIGIN}/api/store/product`))],
        ['POST /api/store/product', () => storeProduct.POST(form({ name: 'x', description: 'd', mrp: '2', price: '1', category: 'c', images: [png()] }))],
        ['POST /api/store/stock-toggle', () => storeStock.POST(json({ productId: 'p1' }))],
        ['GET  /api/store/is-seller', () => storeIsSeller.GET(url(`${ORIGIN}/api/store/is-seller`))],
        ['POST /api/store/ai', () => storeAi.POST(json({ base64Image: 'x', mimeType: 'image/png' }))],
    ]

    // A pending store is the case that leaked data via `storeId: undefined`.
    for (const status of ['pending', 'rejected']) {
        for (const [label, call] of endpoints) {
            it(`${label} returns 401 for a ${status} store`, async () => {
                asSeller(status)
                const { status: code } = await read(await call())
                expect(code).toBe(401)
                expect(prisma.order.findMany).not.toHaveBeenCalled()
                expect(prisma.product.findMany).not.toHaveBeenCalled()
                expect(prisma.rating.findMany).not.toHaveBeenCalled()
            })
        }
    }

    it('a seller with no store at all is refused', async () => {
        getAuth.mockReturnValue({ userId: 'u1', has: () => false })
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', store: null })
        const { status } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))
        expect(status).toBe(401)
    })
})

describe('integration: admin endpoints honour ADMIN_EMAIL configuration', () => {
    const endpoints = [
        ['GET  /api/admin/is-admin', () => adminIsAdmin.GET(url(`${ORIGIN}/api/admin/is-admin`))],
        ['GET  /api/admin/stores', () => adminStores.GET(url(`${ORIGIN}/api/admin/stores`))],
        ['GET  /api/admin/approve-store', () => adminApprove.GET(url(`${ORIGIN}/api/admin/approve-store`))],
        ['POST /api/admin/approve-store', () => adminApprove.POST(json({ storeId: 's1', status: 'approved' }))],
        ['POST /api/admin/toggle-store', () => adminToggle.POST(json({ storeId: 's1' }))],
        ['GET  /api/admin/coupon', () => adminCoupon.GET(url(`${ORIGIN}/api/admin/coupon`))],
        ['POST /api/admin/coupon', () => adminCoupon.POST(json({ coupon: { code: 'x' } }))],
        ['DELETE /api/admin/coupon', () => adminCoupon.DELETE({ ...url(`${ORIGIN}/api/admin/coupon?code=X`) })],
        ['GET  /api/admin/dashboard', () => adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`))],
    ]

    for (const [label, call] of endpoints) {
        it(`${label} refuses a non-admin email`, async () => {
            asAdmin('shopper@example.com')
            const { status } = await read(await call())
            expect(status).toBe(401)
        })
    }

    it('an admin listed with surrounding spaces is still granted access', async () => {
        process.env.ADMIN_EMAIL = 'first@x.com, admin@example.com , last@x.com'
        asAdmin('admin@example.com')
        const { status } = await read(await adminIsAdmin.GET(url(`${ORIGIN}/api/admin/is-admin`)))
        expect(status).toBe(200)
    })

    // The takeover through the real endpoints: an attacker adds ADMIN_EMAIL to
    // their own Clerk account, where it sits at index 0 and unverified.
    it('every admin endpoint refuses an account that merely claims the admin address', async () => {
        getAuth.mockReturnValue({ userId: 'attacker_1', has: () => false })
        clerkGetUser.mockResolvedValue({
            primaryEmailAddressId: 'idn_own',
            emailAddresses: [
                { id: 'idn_claimed', emailAddress: 'admin@example.com', verification: { status: 'unverified' } },
                { id: 'idn_own', emailAddress: 'attacker@example.com', verification: { status: 'verified' } },
            ],
        })
        for (const [label, call] of endpoints) {
            const { status } = await read(await call())
            expect(status, `${label} let the attacker through`).toBe(401)
        }
    })

    it('every admin endpoint is refused when ADMIN_EMAIL is unset', async () => {
        delete process.env.ADMIN_EMAIL
        asAdmin('admin@example.com')
        for (const [, call] of endpoints) {
            expect((await read(await call())).status).toBe(401)
        }
    })
})

describe('integration: seller onboarding propagates state across endpoints', () => {
    it('walks a store from application through approval to a live product', async () => {
        asShopper('u1')
        prisma.store.findFirst.mockResolvedValue(null)
        imagekitUpload.mockResolvedValue({ filePath: '/logos/l.png' })
        prisma.store.create.mockResolvedValue({ id: 'store_1' })
        prisma.user.update.mockResolvedValue({})

        let res = await read(await storeCreate.POST(form({
            name: 'Happy', username: '  HappyShop ', description: 'd',
            email: 'e@x.com', contact: '1', address: 'a', image: png('logo.png'),
        })))
        expect(res.status).toBe(200)
        expect(res.body.message).toBe('applied, waiting for approval')
        expect(prisma.store.create.mock.calls[0][0].data.username).toBe('happyshop')

        asSeller('pending')
        expect((await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))).status).toBe(401)

        vi.clearAllMocks()
        process.env.ADMIN_EMAIL = 'admin@example.com'
        asAdmin()
        prisma.store.update.mockResolvedValue({})
        expect((await read(await adminApprove.POST(json({ storeId: 'store_1', status: 'approved' })))).status).toBe(200)
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ status: 'approved', isActive: true })

        vi.clearAllMocks()
        asSeller('approved')
        imagekitUpload.mockResolvedValue({ filePath: '/products/p.png' })
        prisma.product.create.mockResolvedValue({ id: 'p1' })
        res = await read(await storeProduct.POST(form({
            name: 'Lamp', description: 'A lamp', mrp: '40', price: '29',
            category: 'Decoration', images: [png()],
        })))
        expect(res.status).toBe(200)
        // Bound to the authSeller-resolved store, not to client input.
        expect(prisma.product.create.mock.calls[0][0].data.storeId).toBe('store_1')
    })

    it('rejects a rejected store applying again, surfacing its status', async () => {
        asShopper('u1')
        prisma.store.findFirst.mockResolvedValue({ id: 's1', status: 'rejected' })
        const { body } = await read(await storeCreate.POST(form({
            name: 'n', username: 'u', description: 'd', email: 'e', contact: 'c', address: 'a', image: png(),
        })))
        expect(body.status).toBe('rejected')
        expect(prisma.store.create).not.toHaveBeenCalled()
    })

    it('refuses a username already taken by another store', async () => {
        asShopper('u1')
        prisma.store.findFirst
            .mockResolvedValueOnce(null)                   // this user has no store
            .mockResolvedValueOnce({ id: 'other' })        // but the username exists
        const { status, body } = await read(await storeCreate.POST(form({
            name: 'n', username: 'taken', description: 'd', email: 'e', contact: 'c', address: 'a', image: png(),
        })))
        expect(status).toBe(400)
        expect(body.error).toBe('username already taken')
        expect(imagekitUpload).not.toHaveBeenCalled()
    })

    it('deactivating a store hides it from the public catalogue query', async () => {
        asAdmin()
        prisma.store.findUnique.mockResolvedValue({ id: 'store_1', isActive: true })
        prisma.store.update.mockResolvedValue({})
        await adminToggle.POST(json({ storeId: 'store_1' }))
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ isActive: false })

        vi.clearAllMocks()
        prisma.product.findMany.mockResolvedValue([])
        await productsApi.GET(url(`${ORIGIN}/api/products`))
        expect(prisma.product.findMany.mock.calls[0][0].where)
            .toEqual({ inStock: true, store: SELLABLE_STORE })
    })
})

describe('integration: checkout flow', () => {
    const PRODUCT = { id: 'p1', storeId: 'store_1', price: 100 }
    const body = (o = {}) => ({ addressId: 'addr_1', items: [{ id: 'p1', quantity: 2 }], paymentMethod: 'COD', ...o })

    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([PRODUCT])
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.create.mockResolvedValue({ id: 'order_1' })
        prisma.user.update.mockResolvedValue({})
    })

    it('places a COD order and clears the server-side cart', async () => {
        const { status, body: res } = await read(await orders.POST(json(body())))
        expect(status).toBe(200)
        expect(res.message).toBe('Orders Placed Successfully')
        // Cleared inside the same transaction as the orders, so the two cannot
        // disagree; updateMany because it must not fail on a missing row.
        expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
    })

    it('prices from the database, ignoring any client-supplied price', async () => {
        await orders.POST(json(body({ items: [{ id: 'p1', quantity: 2, price: 0.01 }] })))
        const data = prisma.order.create.mock.calls[0][0].data
        expect(data.total).toBe(205)                     // 2x100 + 5 shipping
        expect(data.orderItems.create[0].price).toBe(100)
    })

    const badItems = [
        ['negative quantity', [{ id: 'p1', quantity: -5 }]],
        ['zero quantity', [{ id: 'p1', quantity: 0 }]],
        ['fractional quantity', [{ id: 'p1', quantity: 1.5 }]],
        ['string quantity', [{ id: 'p1', quantity: '2' }]],
        ['missing id', [{ quantity: 1 }]],
    ]
    for (const [label, items] of badItems) {
        it(`rejects ${label} before creating anything`, async () => {
            const { status, body: res } = await read(await orders.POST(json(body({ items }))))
            expect(status).toBe(400)
            expect(res.error).toBe('invalid order items')
            expect(prisma.order.create).not.toHaveBeenCalled()
        })
    }

    it("rejects another user's address", async () => {
        prisma.address.findFirst.mockResolvedValue(null)
        const { status } = await read(await orders.POST(json(body())))
        expect(status).toBe(400)
        expect(prisma.address.findFirst).toHaveBeenCalledWith({ where: { id: 'addr_1', userId: 'u1' } })
        expect(prisma.order.create).not.toHaveBeenCalled()
    })

    it('rejects an unavailable product and only queries purchasable ones', async () => {
        prisma.product.findMany.mockResolvedValue([])
        const { status, body: res } = await read(await orders.POST(json(body())))
        expect(status).toBe(400)
        expect(res.error).toBe('product is unavailable')
        expect(prisma.product.findMany.mock.calls[0][0].where).toEqual({
            id: { in: ['p1'] }, inStock: true, store: { isActive: true, status: 'approved' },
        })
    })

    it('rejects an unknown payment method', async () => {
        const { status } = await read(await orders.POST(json(body({ paymentMethod: 'BITCOIN' }))))
        expect(status).toBe(400)
    })

    it('splits a multi-store basket into one order per store, charging shipping once', async () => {
        prisma.product.findMany.mockResolvedValue([PRODUCT, { id: 'p2', storeId: 'store_2', price: 50 }])
        await orders.POST(json(body({ items: [{ id: 'p1', quantity: 1 }, { id: 'p2', quantity: 1 }] })))
        expect(prisma.order.create).toHaveBeenCalledTimes(2)
        expect(prisma.order.create.mock.calls.map(c => c[0].data.total)).toEqual([105, 50])
    })

    it('waives shipping for a plus member', async () => {
        asShopper('u1', true)
        await orders.POST(json(body({ items: [{ id: 'p1', quantity: 1 }] })))
        expect(prisma.order.create.mock.calls[0][0].data.total).toBe(100)
    })

    it('rejects an expired coupon, matching /api/coupon behaviour', async () => {
        prisma.coupon.findFirst.mockResolvedValue(null)
        const { status } = await read(await orders.POST(json(body({ couponCode: 'OLD20' }))))
        expect(status).toBe(400)
        expect(prisma.coupon.findFirst.mock.calls[0][0].where.expiresAt.gt).toBeInstanceOf(Date)
    })

    it('applies a valid discount and records the coupon on the order', async () => {
        asShopper('u1', true)
        prisma.coupon.findFirst.mockResolvedValue({ code: 'OFF10', discount: 10, forNewUser: false, forMember: false })
        await orders.POST(json(body({ couponCode: 'OFF10' })))
        const data = prisma.order.create.mock.calls[0][0].data
        expect(data.total).toBe(180)
        expect(data.isCouponUsed).toBe(true)
    })

    it('refuses a new-user coupon once the buyer has history', async () => {
        prisma.coupon.findFirst.mockResolvedValue({ code: 'NEW20', discount: 20, forNewUser: true, forMember: false })
        prisma.order.findMany.mockResolvedValue([{ id: 'old' }])
        expect((await read(await orders.POST(json(body({ couponCode: 'NEW20' }))))).status).toBe(400)
    })

    it('refuses a members-only coupon for a non-member', async () => {
        prisma.coupon.findFirst.mockResolvedValue({ code: 'PLUS10', discount: 10, forNewUser: false, forMember: true })
        expect((await read(await orders.POST(json(body({ couponCode: 'PLUS10' }))))).status).toBe(400)
    })

    it('/api/coupon and /api/orders agree on expiry filtering', async () => {
        prisma.coupon.findFirst.mockResolvedValue(null)
        await couponApi.POST(json({ code: 'OLD' }))
        const couponWhere = prisma.coupon.findFirst.mock.calls[0][0].where
        vi.clearAllMocks()
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([PRODUCT])
        prisma.coupon.findFirst.mockResolvedValue(null)
        await orders.POST(json(body({ couponCode: 'OLD' })))
        const orderWhere = prisma.coupon.findFirst.mock.calls[0][0].where
        expect(Object.keys(couponWhere).sort()).toEqual(Object.keys(orderWhere).sort())
    })

    it('routes an online order to a payment link instead of clearing the cart', async () => {
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
        const { status, body: res } = await read(await orders.POST(json(body({ paymentMethod: 'RAZORPAY' }))))
        expect(status).toBe(200)
        expect(res.session.url).toBe('https://rzp.test/i/1')
        // Cleared by the webhook only once payment succeeds.
        expect(prisma.user.update).not.toHaveBeenCalled()

        const link = razorpayCreateLink.mock.calls[0][0]
        expect(link.notes.appId).toBe('gocart')
        expect(link.notes.orderIds).toBe('order_1')
        expect(link.amount).toBe(20500)
        expect(link.callback_url).toBe(`${ORIGIN}/loading?nextUrl=orders`)
    })

    it('falls back to the request origin when the Origin header is absent', async () => {
        razorpayCreateLink.mockResolvedValue({ url: 'x' })
        await orders.POST({
            json: async () => body({ paymentMethod: 'RAZORPAY' }),
            headers: new Headers(), nextUrl: new URL(ORIGIN), url: ORIGIN,
        })
        expect(razorpayCreateLink.mock.calls[0][0].callback_url).toBe(`${ORIGIN}/loading?nextUrl=orders`)
    })
})

describe('integration: ratings are gated on a matching purchase', () => {
    const rating = (o = {}) => ({ orderId: 'o1', productId: 'p1', rating: 5, review: 'Great', ...o })

    beforeEach(() => {
        asShopper('u1')
        prisma.order.findFirst.mockResolvedValue({ id: 'o1', userId: 'u1' })
        prisma.rating.findFirst.mockResolvedValue(null)
        prisma.rating.create.mockResolvedValue({ id: 'r1' })
    })

    it('accepts a rating for a purchased product', async () => {
        expect((await read(await ratingApi.POST(json(rating())))).status).toBe(200)
    })

    it('scopes the order lookup by user and by line item', async () => {
        await ratingApi.POST(json(rating()))
        const { where } = prisma.order.findFirst.mock.calls[0][0]
        expect(where.id).toBe('o1')
        expect(where.userId).toBe('u1')
        expect(where.orderItems).toEqual({ some: { productId: 'p1' } })
    })

    it('refuses a product that is not in the order', async () => {
        prisma.order.findFirst.mockResolvedValue(null)
        const { status } = await read(await ratingApi.POST(json(rating({ productId: 'other' }))))
        expect(status).toBe(404)
        expect(prisma.rating.create).not.toHaveBeenCalled()
    })

    for (const v of [0, 6, -1, 2.5, '5', null, undefined, NaN]) {
        it(`refuses out-of-range rating ${String(v)}`, async () => {
            const { status } = await read(await ratingApi.POST(json(rating({ rating: v }))))
            expect(status).toBe(400)
            expect(prisma.rating.create).not.toHaveBeenCalled()
        })
    }

    it('refuses a duplicate rating', async () => {
        prisma.rating.findFirst.mockResolvedValue({ id: 'existing' })
        expect((await read(await ratingApi.POST(json(rating())))).status).toBe(400)
    })
})

describe('integration: catalogue and storefront', () => {
    it('never returns products from a deactivated store', async () => {
        prisma.product.findMany.mockResolvedValue([])
        await productsApi.GET(url(`${ORIGIN}/api/products`))
        expect(prisma.product.findMany.mock.calls[0][0].where.store).toEqual(SELLABLE_STORE)
    })

    it('hides internal errors behind a generic 500', async () => {
        prisma.product.findMany.mockRejectedValue(new Error('relation "Product" does not exist'))
        const { status, body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))
        expect(status).toBe(500)
        expect(body.error).toBe('An internal server error occurred.')
        expect(JSON.stringify(body)).not.toContain('relation')
    })

    it('returns 400 rather than crashing on a missing store username', async () => {
        for (const u of [`${ORIGIN}/api/store/data`, `${ORIGIN}/api/store/data?username=`]) {
            const { status, body } = await read(await storeData.GET(url(u)))
            expect(status).toBe(400)
            expect(body.error).toBe('missing username')
        }
        expect(prisma.store.findUnique).not.toHaveBeenCalled()
    })

    it('looks up a storefront case-insensitively and only when active', async () => {
        prisma.store.findUnique.mockResolvedValue({ id: 's1', Product: [] })
        await storeData.GET(url(`${ORIGIN}/api/store/data?username=HappyShop`))
        expect(prisma.store.findUnique.mock.calls[0][0].where).toEqual({ username: 'happyshop', ...SELLABLE_STORE })
    })
})

describe('integration: cart and address persistence', () => {
    beforeEach(() => asShopper('u1'))

    it('round-trips the cart for a signed-in shopper', async () => {
        prisma.user.update.mockResolvedValue({})
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }])
        expect((await read(await cartApi.POST(json({ cart: { p1: 2 } })))).status).toBe(200)
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: { p1: 2 } } })

        prisma.user.findUnique.mockResolvedValue({ cart: { p1: 2 } })
        const { body } = await read(await cartApi.GET(url(`${ORIGIN}/api/cart`)))
        expect(body.cart).toEqual({ p1: 2 })
    })

    it('returns an empty cart when the user row does not exist yet', async () => {
        prisma.user.findUnique.mockResolvedValue(null)
        const { status, body } = await read(await cartApi.GET(url(`${ORIGIN}/api/cart`)))
        expect(status).toBe(200)
        expect(body.cart).toEqual({})
    })

    it('binds a new address to the session user and ignores a client-supplied id', async () => {
        prisma.address.create.mockResolvedValue({ id: 'generated' })
        await addressApi.POST(json({
            address: {
                id: 'attacker_id', userId: 'someone_else', name: 'A', email: 'a@b.c',
                street: 'S', city: 'C', state: 'ST', zip: '1', country: 'X', phone: '2',
            },
        }))
        const data = prisma.address.create.mock.calls[0][0].data
        expect(data.userId).toBe('u1')
        expect(data).not.toHaveProperty('id')
    })

    it('scopes address listing to the caller', async () => {
        prisma.address.findMany.mockResolvedValue([])
        await addressApi.GET(url(`${ORIGIN}/api/address`))
        expect(prisma.address.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    })
})

// The buyer and seller views each carried their own copy of "which orders
// count" and drifted apart. These pin both to one shared definition.
// The catalogue used to return every purchasable product, with every review
// attached, on every page load of the storefront.
describe('integration: the catalogue is a page, not the whole table', () => {
    const product = (id, ratings = []) => ({ id, name: `p${id}`, price: 10, store: {}, rating: ratings })

    beforeEach(() => { __resetRateLimits() })

    it('asks for a bounded page and reports whether more exists', async () => {
        // One row beyond the page, so "is there more" needs no second query.
        prisma.product.findMany.mockResolvedValue(Array.from({ length: 25 }, (_, i) => product(`p${i}`)))
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))

        expect(prisma.product.findMany.mock.calls[0][0].take).toBe(25)
        expect(body.products).toHaveLength(24)
        expect(body.nextCursor).toBe('p23')
    })

    it('reports no cursor when the page is the last one', async () => {
        prisma.product.findMany.mockResolvedValue([product('a'), product('b')])
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))
        expect(body.products).toHaveLength(2)
        expect(body.nextCursor).toBeNull()
    })

    it('continues from a cursor without repeating it', async () => {
        prisma.product.findMany.mockResolvedValue([product('c')])
        await productsApi.GET(url(`${ORIGIN}/api/products?cursor=b`))
        const args = prisma.product.findMany.mock.calls[0][0]
        expect(args.cursor).toEqual({ id: 'b' })
        expect(args.skip).toBe(1)
    })

    it('caps the page size a caller may ask for', async () => {
        prisma.product.findMany.mockResolvedValue([])
        await productsApi.GET(url(`${ORIGIN}/api/products?limit=100000`))
        expect(prisma.product.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(101)
    })

    it('searches in the database, not in the page already downloaded', async () => {
        // Filtering client-side could only ever match products already fetched,
        // so a match further into the catalogue was unreachable.
        prisma.product.findMany.mockResolvedValue([])
        await productsApi.GET(url(`${ORIGIN}/api/products?search=lamp`))
        const { where } = prisma.product.findMany.mock.calls[0][0]
        expect(where.OR).toEqual([
            { name: { contains: 'lamp', mode: 'insensitive' } },
            { category: { contains: 'lamp', mode: 'insensitive' } },
        ])
        expect(where.store).toEqual(SELLABLE_STORE)
    })

    it('summarises ratings instead of shipping every review', async () => {
        prisma.product.findMany.mockResolvedValue([
            product('a', [{ rating: 5 }, { rating: 4 }, { rating: 3 }]),
        ])
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))

        expect(body.products[0].ratingCount).toBe(3)
        expect(body.products[0].ratingAverage).toBe(4)
        // The reviews themselves belong on the product page, which is the only
        // screen that renders them.
        expect(body.products[0].rating).toBeUndefined()
    })

    it('reports a zero average for a product nobody has reviewed', async () => {
        prisma.product.findMany.mockResolvedValue([product('a')])
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))
        expect(body.products[0].ratingCount).toBe(0)
        expect(body.products[0].ratingAverage).toBe(0)
    })

    // The risk paginating introduces: a basket outlives the page being browsed.
    it('resolves specific products by id, so a basket is never silently emptied', async () => {
        prisma.product.findMany.mockResolvedValue([product('in_cart')])
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products?ids=in_cart,gone`)))

        const { where } = prisma.product.findMany.mock.calls[0][0]
        expect(where.id).toEqual({ in: ['in_cart', 'gone'] })
        expect(body.products).toHaveLength(1)
        // An id lookup is not a page, so it carries no cursor.
        expect(body.nextCursor).toBeNull()
    })

    it('still applies purchasability to an id lookup', async () => {
        prisma.product.findMany.mockResolvedValue([])
        await productsApi.GET(url(`${ORIGIN}/api/products?ids=a`))
        const { where } = prisma.product.findMany.mock.calls[0][0]
        expect(where.inStock).toBe(true)
        expect(where.store).toEqual(SELLABLE_STORE)
    })

    it('bounds how many ids one lookup may ask for', async () => {
        prisma.product.findMany.mockResolvedValue([])
        const many = Array.from({ length: 500 }, (_, i) => `p${i}`).join(',')
        await productsApi.GET(url(`${ORIGIN}/api/products?ids=${many}`))
        expect(prisma.product.findMany.mock.calls[0][0].where.id.in.length).toBeLessThanOrEqual(100)
    })

    it('answers an empty id list without querying', async () => {
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products?ids=`)))
        expect(body.products).toEqual([])
    })
})

// If every webhook delivery fails, nothing in the request path can notice --
// the request path is what failed.
describe('integration: scheduled reconciliation and retention', () => {
    // Runs each step inline, so the handler's real logic is exercised.
    const step = { run: async (_name, fn) => fn() }
    const asyncList = (items) => ({
        data: items,
        [Symbol.asyncIterator]: async function* () { for (const i of items) yield i },
    })

    describe('reconcileRazorpayPayments', () => {
        const link = (o = {}) => ({
            id: 'plink_1',
            status: 'paid',
            notes: { orderIds: 'o1', userId: 'u1', appId: 'gocart' },
            ...o,
        })
        const page = (links) => razorpayListLinks.mockResolvedValue({ payment_links: links })

        beforeEach(() => {
            process.env.RAZORPAY_KEY_ID = 'rzp_test_x'
            process.env.RAZORPAY_KEY_SECRET = 'secret'
            prisma.order.updateMany.mockResolvedValue({ count: 0 })
        })

        it('marks an order paid that Razorpay charged but the webhook never recorded', async () => {
            page([link({ notes: { orderIds: 'o1,o2', userId: 'u1', appId: 'gocart' } })])
            prisma.order.updateMany.mockResolvedValue({ count: 2 })

            const result = await jobs.reconcileRazorpayPayments.handler({ step })

            expect(prisma.order.updateMany).toHaveBeenCalledWith({
                where: { id: { in: ['o1', 'o2'] }, isPaid: false },
                data: { isPaid: true },
            })
            expect(result).toEqual({ repaired: 1 })
        })

        it('clears the cart of the shopper whose payment it repaired', async () => {
            page([link()])
            prisma.order.updateMany.mockResolvedValue({ count: 1 })
            await jobs.reconcileRazorpayPayments.handler({ step })
            expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
        })

        it('reports nothing repaired when the webhook already did the work', async () => {
            page([link()])
            // updateMany matched no unpaid row: the webhook got there first.
            prisma.order.updateMany.mockResolvedValue({ count: 0 })
            const result = await jobs.reconcileRazorpayPayments.handler({ step })
            expect(result).toEqual({ repaired: 0 })
            expect(prisma.user.updateMany).not.toHaveBeenCalled()
        })

        it('only ever moves an order from unpaid to paid', async () => {
            page([link()])
            await jobs.reconcileRazorpayPayments.handler({ step })
            expect(prisma.order.updateMany.mock.calls[0][0].where.isPaid).toBe(false)
        })

        it('ignores links that were never paid', async () => {
            page([link({ status: 'created' }), link({ id: 'plink_2', status: 'cancelled' })])
            await jobs.reconcileRazorpayPayments.handler({ step })
            expect(prisma.order.updateMany).not.toHaveBeenCalled()
        })

        it('ignores links belonging to another app sharing the Razorpay account', async () => {
            page([link({ notes: { orderIds: 'o1', userId: 'u1', appId: 'other' } })])
            await jobs.reconcileRazorpayPayments.handler({ step })
            expect(prisma.order.updateMany).not.toHaveBeenCalled()
        })

        it('survives a link carrying no notes at all', async () => {
            page([link({ notes: undefined })])
            await expect(jobs.reconcileRazorpayPayments.handler({ step })).resolves.toEqual({ repaired: 0 })
        })

        it('walks past the first page rather than repairing only the newest 100', async () => {
            // A full page means there may be more; a short one ends the walk.
            const full = Array.from({ length: 100 }, (_, i) => link({ id: `plink_${i}`, status: 'created' }))
            razorpayListLinks
                .mockResolvedValueOnce({ payment_links: full })
                .mockResolvedValueOnce({ payment_links: [link()] })
            prisma.order.updateMany.mockResolvedValue({ count: 1 })

            const result = await jobs.reconcileRazorpayPayments.handler({ step })

            expect(razorpayListLinks).toHaveBeenCalledTimes(2)
            expect(razorpayListLinks.mock.calls[1][0].skip).toBe(100)
            expect(result).toEqual({ repaired: 1 })
        })

        it('stops after a short page', async () => {
            page([link({ status: 'created' })])
            await jobs.reconcileRazorpayPayments.handler({ step })
            expect(razorpayListLinks).toHaveBeenCalledTimes(1)
        })

        it('runs on a schedule rather than waiting to be asked', () => {
            expect(jobs.reconcileRazorpayPayments.trigger.cron).toBeTruthy()
        })
    })

    describe('pruneCheckoutArtifacts', () => {
        beforeEach(() => {
            prisma.checkoutRequest.deleteMany = vi.fn().mockResolvedValue({ count: 3 })
            prisma.order.deleteMany.mockResolvedValue({ count: 2 })
        })

        it('clears idempotency keys past their retention window', async () => {
            const result = await jobs.pruneCheckoutArtifacts.handler({ step })
            expect(result.checkoutRequests).toBe(3)
            const { where } = prisma.checkoutRequest.deleteMany.mock.calls[0][0]
            expect(where.createdAt.lt).toBeInstanceOf(Date)
            expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThan(29 * 86400000)
        })

        it('deletes only abandoned card orders, never a paid one', async () => {
            await jobs.pruneCheckoutArtifacts.handler({ step })
            const { where } = prisma.order.deleteMany.mock.calls[0][0]
            expect(where.isPaid).toBe(false)
            expect(where.paymentMethod).toEqual({ in: ['STRIPE', 'RAZORPAY'] })
            // Far older than the reconciliation window, so a payment still
            // awaiting repair is never destroyed.
            expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThan(29 * 86400000)
        })

        it('leaves cash-on-delivery orders alone entirely', async () => {
            await jobs.pruneCheckoutArtifacts.handler({ step })
            expect(prisma.order.deleteMany.mock.calls[0][0].where.paymentMethod).not.toBe('COD')
        })

        it('runs on a schedule', () => {
            expect(jobs.pruneCheckoutArtifacts.trigger.cron).toBeTruthy()
        })
    })
})

// Residual-risk pass. Defects left standing by the finding-by-finding work,
// collected in §15 of the audit and corrected together.
describe('integration: residual correctness gaps', () => {
    const body = (over = {}) => ({
        addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD', ...over,
    })

    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.findFirst.mockResolvedValue(null)
        prisma.order.count.mockResolvedValue(0)
        prisma.order.create.mockResolvedValue({ id: 'o1' })
        prisma.order.updateMany.mockResolvedValue({ count: 1 })
        prisma.user.updateMany.mockResolvedValue({ count: 1 })
        prisma.checkoutRequest.findUnique.mockResolvedValue(null)
        prisma.checkoutRequest.create.mockResolvedValue({})
    })

    // #21 — an abandoned checkout made a genuinely new shopper ineligible.
    it('does not let an abandoned checkout spend a new-user coupon', async () => {
        prisma.coupon.findFirst.mockResolvedValue({ code: 'NEW20', discount: 20, forNewUser: true, forMember: false, maxRedemptions: null })
        await orders.POST(json(body({ couponCode: 'NEW20' })))

        // The eligibility query must exclude orders that never completed.
        const eligibility = prisma.order.findMany.mock.calls[0][0]
        expect(eligibility.where.userId).toBe('u1')
        expect(eligibility.where).toMatchObject(PLACED_ORDER)
    })

    // #34 — a provider rejects a zero-amount request, so a full-value coupon failed.
    it('settles a zero-total basket instead of opening an impossible payment page', async () => {
        asShopper('u1', true)                                   // member: no shipping
        prisma.coupon.findFirst.mockResolvedValue({ code: 'FREE', discount: 100, forNewUser: false, forMember: false, maxRedemptions: null })

        const { status, body: res } = await read(await orders.POST(json(body({
            paymentMethod: 'RAZORPAY', couponCode: 'FREE',
        }))))

        expect(status).toBe(200)
        expect(res.message).toBe('Orders Placed Successfully')
        expect(razorpayCreateLink).not.toHaveBeenCalled()
        // Nothing is owed, so the order is settled and the cart cleared.
        expect(prisma.order.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['o1'] } }, data: { isPaid: true },
        })
    })

    it('still opens a payment page when anything is owed', async () => {
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
        const { status } = await read(await orders.POST(json(body({ paymentMethod: 'RAZORPAY' }))))
        expect(status).toBe(200)
        expect(razorpayCreateLink).toHaveBeenCalled()
    })

    // #58 — a key was honoured whoever presented it.
    it('refuses an idempotency key belonging to another shopper', async () => {
        prisma.checkoutRequest.findUnique.mockResolvedValue({
            key: 'k', userId: 'someone_else', orderIds: ['o9'], paymentMethod: 'COD', sessionUrl: null,
        })
        const req = { ...json(body()), headers: new Headers({ origin: ORIGIN, 'Idempotency-Key': 'k' }) }

        const { status } = await read(await orders.POST(req))
        expect(status).toBe(409)
        expect(prisma.order.create).not.toHaveBeenCalled()
    })

    // #14 — the endpoint described its own body to anonymous callers.
    it('authenticates the stock toggle before reading its body', async () => {
        anonymous()
        const { status } = await read(await storeStock.POST(json({})))
        expect(status).toBe(401)
    })

    // #18 — a row mirrored once was never corrected.
    it('repairs a placeholder user row rather than leaving it stale forever', async () => {
        asShopper('u1')
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: '', email: '', image: '' })
        clerkGetUser.mockResolvedValue({
            firstName: 'Ada', lastName: 'Lovelace', imageUrl: 'https://img/a.png',
            emailAddresses: [{ emailAddress: 'ada@example.com' }],
        })
        prisma.user.update.mockResolvedValue({})
        prisma.address.create.mockResolvedValue({ id: 'a1' })

        await addressApi.POST(json({ address: { name: 'Ada' } }))

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { name: 'Ada Lovelace', email: 'ada@example.com', image: 'https://img/a.png' },
        })
        // Never the cart: that is the shopper's, not Clerk's.
        expect(prisma.user.update.mock.calls[0][0].data.cart).toBeUndefined()
    })

    it('leaves a complete user row alone', async () => {
        asShopper('u1')
        prisma.user.update.mockResolvedValue({})
        prisma.address.create.mockResolvedValue({ id: 'a1' })
        await addressApi.POST(json({ address: { name: 'Ada' } }))
        expect(clerkGetUser).not.toHaveBeenCalled()
        expect(prisma.user.update).not.toHaveBeenCalled()
    })
})

// F-27. Nothing limited how often a caller could reach the endpoints that cost
// money, and nothing limited what one call could cost.
describe('integration: expensive endpoints have a budget', () => {
    const aiBody = () => json({ base64Image: PNG_BASE64, mimeType: 'image/png' })

    beforeEach(() => {
        asSeller('approved', 'store_1')
        openaiCreate.mockResolvedValue({ choices: [{ message: { content: '{"name":"n","description":"d"}' } }] })
    })

    it('refuses a caller who exceeds the AI budget, with a Retry-After', async () => {
        for (let i = 0; i < 10; i++) {
            expect((await read(await storeAi.POST(aiBody()))).status).toBe(200)
        }
        const res = await storeAi.POST(aiBody())
        expect(res.status).toBe(429)
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
        // The eleventh call must not reach the paid model.
        expect(openaiCreate).toHaveBeenCalledTimes(10)
    })

    it('budgets each seller separately', async () => {
        for (let i = 0; i < 10; i++) await storeAi.POST(aiBody())
        expect((await read(await storeAi.POST(aiBody()))).status).toBe(429)

        // A different seller is unaffected.
        asSeller('approved', 'store_2', 'u2')
        expect((await read(await storeAi.POST(aiBody()))).status).toBe(200)
    })

    it('refuses an oversized image before spending anything', async () => {
        const huge = PNG_BASE64 + 'A'.repeat(MAX_IMAGE_BYTES * 2)
        const { status } = await read(await storeAi.POST(json({ base64Image: huge, mimeType: 'image/png' })))
        expect(status).toBe(400)
        expect(openaiCreate).not.toHaveBeenCalled()
    })

    it('refuses a type the storefront cannot display', async () => {
        for (const mimeType of ['application/pdf', 'image/svg+xml', '', undefined]) {
            const { status } = await read(await storeAi.POST(json({ base64Image: PNG_BASE64, mimeType })))
            expect(status, `accepted ${mimeType}`).toBe(400)
        }
        expect(openaiCreate).not.toHaveBeenCalled()
    })

    it('caps how many images one product may carry', async () => {
        const images = Array.from({ length: MAX_IMAGES_PER_PRODUCT + 1 }, (_, i) => png(`${i}.png`))
        const { status, body } = await read(await storeProduct.POST(form({
            name: 'n', description: 'd', mrp: '2', price: '1', category: 'c', images,
        })))
        expect(status).toBe(400)
        expect(body.error).toMatch(/at most/)
        expect(imagekitUpload).not.toHaveBeenCalled()
    })

    it('rejects a bad upload before any transfer starts', async () => {
        // One rejected request rather than several transfers to ImageKit.
        const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.pdf', { type: 'application/pdf' })
        const { status } = await read(await storeProduct.POST(form({
            name: 'n', description: 'd', mrp: '2', price: '1', category: 'c', images: [png(), pdf],
        })))
        expect(status).toBe(400)
        expect(imagekitUpload).not.toHaveBeenCalled()
    })

    it('limits the endpoints the audit named', async () => {
        // Each is reached by a distinct caller so the budgets do not interact.
        const cases = [
            ['/api/coupon', 20, async () => {
                asShopper('rl1')
                prisma.coupon.findFirst.mockResolvedValue(null)
                return couponApi.POST(json({ code: 'X' }))
            }],
            ['/api/store/create', 5, async () => {
                asShopper('rl2')
                prisma.store.findFirst.mockResolvedValue({ status: 'pending' })
                return storeCreate.POST(form({
                    name: 'S', username: 'u', description: 'd', email: 'e@x.com',
                    contact: '1', address: 'a', image: png(),
                }))
            }],
        ]

        for (const [route, limit, call] of cases) {
            __resetRateLimits()
            for (let i = 0; i < limit; i++) {
                expect((await call()).status, `${route} refused too early`).not.toBe(429)
            }
            expect((await call()).status, `${route} is unlimited`).toBe(429)
        }
    })

    it('refuses a file whose bytes contradict its claimed type', async () => {
        // `mimeType` is a string the caller chose; the bytes are not.
        const pdfAsPng = Buffer.from([0x25, 0x50, 0x44, 0x46]).toString('base64')
        const { status } = await read(await storeAi.POST(json({ base64Image: pdfAsPng, mimeType: 'image/png' })))
        expect(status).toBe(400)
        expect(openaiCreate).not.toHaveBeenCalled()
    })

    it('refuses an upload whose bytes contradict its File.type', async () => {
        const disguised = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.png', { type: 'image/png' })
        const { status } = await read(await storeProduct.POST(form({
            name: 'n', description: 'd', mrp: '2', price: '1', category: 'c', images: [disguised],
        })))
        expect(status).toBe(400)
        expect(imagekitUpload).not.toHaveBeenCalled()
    })

    it('budgets anonymous callers on the public reads', async () => {
        // Every limit used to be keyed by userId, so an unauthenticated endpoint
        // had no budget at all.
        __resetRateLimits()
        prisma.product.findMany.mockResolvedValue([])
        const req = () => ({ ...url(`${ORIGIN}/api/products`), headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }) })

        let refused = 0
        for (let i = 0; i < 130; i++) {
            if ((await productsApi.GET(req())).status === 429) refused++
        }
        expect(refused).toBeGreaterThan(0)
    })

    it('budgets anonymous callers separately by address', async () => {
        __resetRateLimits()
        prisma.product.findMany.mockResolvedValue([])
        const from = (ip) => ({ ...url(`${ORIGIN}/api/products`), headers: new Headers({ 'x-forwarded-for': ip }) })

        for (let i = 0; i < 130; i++) await productsApi.GET(from('203.0.113.1'))
        // A different visitor is unaffected by the first one's usage.
        expect((await productsApi.GET(from('203.0.113.2'))).status).toBe(200)
    })

    it('does not limit the storefront itself', async () => {
        // Browsing is not the expensive path; rate limiting it would be a
        // self-inflicted outage.
        prisma.product.findMany.mockResolvedValue([])
        for (let i = 0; i < 50; i++) {
            expect((await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))).status).toBe(200)
        }
    })
})

// "Can this store sell?" was three different questions: the catalogue asked
// only whether it was active, checkout asked active *and* approved.
describe('integration: one definition of a store that can sell', () => {
    it('every public read applies the same store predicate as checkout', async () => {
        const storeWhereOf = async (run, setup = () => {}) => {
            vi.clearAllMocks()
            prisma.product.findMany.mockResolvedValue([])
            prisma.product.findFirst.mockResolvedValue({ id: 'p1', rating: [], store: {} })
            prisma.store.findUnique.mockResolvedValue({ id: 's1', Product: [] })
            prisma.order.findMany.mockResolvedValue([])
            setup()
            return run()
        }

        await storeWhereOf(() => productsApi.GET(url(`${ORIGIN}/api/products`)))
        const catalogue = prisma.product.findMany.mock.calls[0][0].where.store

        await storeWhereOf(() => productById.GET(url(`${ORIGIN}/api/products/p1`), { params: Promise.resolve({ productId: 'p1' }) }))
        const byId = prisma.product.findFirst.mock.calls[0][0].where.store

        await storeWhereOf(() => storeData.GET(url(`${ORIGIN}/api/store/data?username=shop`)))
        const storePage = prisma.store.findUnique.mock.calls[0][0].where

        await storeWhereOf(() => orders.POST(json({
            addressId: 'a1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD',
        })), () => {
            asShopper('u1')
            prisma.address.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1' })
        })
        const checkout = prisma.product.findMany.mock.calls[0][0].where.store

        for (const [name, where] of Object.entries({ catalogue, byId, storePage, checkout })) {
            expect(where, `${name} uses a different definition`).toMatchObject(SELLABLE_STORE)
        }
        // The specific divergence: a shopper must never reach a product they
        // will then be refused at the till.
        expect(catalogue).toEqual(checkout)
    })

    it('requires approval, not merely being switched on', () => {
        expect(SELLABLE_STORE).toEqual({ isActive: true, status: 'approved' })
    })

    it('no route decides store eligibility on its own', () => {
        // Inline `isActive: true` is the shape that let the definitions drift.
        // The two routes that *set* the flag are named rather than matched.
        const SETS_THE_FLAG = ['/api/admin/approve-store', '/api/admin/toggle-store']

        const offenders = routeFiles()
            .filter(({ route }) => !SETS_THE_FLAG.includes(route))
            .filter(({ file }) => /isActive:\s*true/.test(
                readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
            ))
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })

    it('rejection takes a live store off the storefront', async () => {
        asAdmin()
        prisma.store.update.mockResolvedValue({})
        await adminApprove.POST(json({ storeId: 's1', status: 'rejected' }))
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ status: 'rejected', isActive: false })
    })

    it('approval still switches a store on', async () => {
        asAdmin()
        prisma.store.update.mockResolvedValue({})
        await adminApprove.POST(json({ storeId: 's1', status: 'approved' }))
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ status: 'approved', isActive: true })
    })
})

// F-22. A review only had to belong to an order, not a delivered one, and a
// coupon could be redeemed by the same account without limit.
describe('integration: a review needs a delivery, a coupon needs a redemption left', () => {
    describe('reviews', () => {
        beforeEach(() => {
            asShopper('u1')
            prisma.rating.findFirst.mockResolvedValue(null)
            prisma.rating.create.mockResolvedValue({ id: 'r1' })
        })

        it('requires the order to be delivered', async () => {
            // The orders screen already hides the button until then; this is the
            // same rule applied where it can be relied on.
            prisma.order.findFirst.mockResolvedValue({ id: 'o1' })
            await ratingApi.POST(json({ orderId: 'o1', productId: 'p1', rating: 5, review: 'great' }))
            const { where } = prisma.order.findFirst.mock.calls[0][0]
            expect(where.status).toBe('DELIVERED')
            expect(where).toMatchObject(PLACED_ORDER)
        })

        it('refuses a review for an order that has not been delivered', async () => {
            prisma.order.findFirst.mockResolvedValue(null)
            const { status, body } = await read(await ratingApi.POST(
                json({ orderId: 'o1', productId: 'p1', rating: 5, review: 'great' })))
            expect(status).toBe(404)
            expect(body.error).toMatch(/delivered/i)
            expect(prisma.rating.create).not.toHaveBeenCalled()
        })
    })

    describe('coupon redemption', () => {
        const COUPON = { code: 'SAVE10', discount: 10, forNewUser: false, forMember: false, maxRedemptions: null }
        const body = { addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD', couponCode: 'SAVE10' }

        beforeEach(() => {
            asShopper('u1')
            prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
            prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
            prisma.order.findMany.mockResolvedValue([])
            prisma.order.findFirst.mockResolvedValue(null)
            prisma.order.count.mockResolvedValue(0)
            prisma.order.create.mockResolvedValue({ id: 'o1' })
            prisma.user.updateMany.mockResolvedValue({ count: 1 })
            prisma.coupon.findFirst.mockResolvedValue(COUPON)
        })

        it('records the code on the order so redemption can be counted', async () => {
            await orders.POST(json(body))
            expect(prisma.order.create.mock.calls[0][0].data.couponCode).toBe('SAVE10')
        })

        it('refuses a second use by the same shopper', async () => {
            prisma.order.findFirst.mockResolvedValue({ id: 'earlier_order' })
            const { status, body: res } = await read(await orders.POST(json(body)))

            expect(status).toBe(400)
            expect(res.error).toMatch(/already used this coupon/i)
            expect(prisma.order.create).not.toHaveBeenCalled()
        })

        it('counts only orders that actually stand', async () => {
            // An abandoned online checkout must not burn the shopper's coupon.
            await orders.POST(json(body))
            const { where } = prisma.order.findFirst.mock.calls[0][0]
            expect(where.userId).toBe('u1')
            expect(where.couponCode).toBe('SAVE10')
            expect(where).toMatchObject(PLACED_ORDER)
        })

        it('enforces a platform-wide cap when one is set', async () => {
            prisma.coupon.findFirst.mockResolvedValue({ ...COUPON, maxRedemptions: 100 })
            prisma.order.count.mockResolvedValue(100)

            const { status, body: res } = await read(await orders.POST(json(body)))
            expect(status).toBe(400)
            expect(res.error).toMatch(/no longer available/i)
            expect(prisma.order.create).not.toHaveBeenCalled()
        })

        it('allows the redemption that reaches the cap', async () => {
            prisma.coupon.findFirst.mockResolvedValue({ ...COUPON, maxRedemptions: 100 })
            prisma.order.count.mockResolvedValue(99)
            expect((await read(await orders.POST(json(body)))).status).toBe(200)
        })

        it('does not count redemptions when no cap is set', async () => {
            await orders.POST(json(body))
            expect(prisma.order.count).not.toHaveBeenCalled()
        })

        it('treats a zero cap as exhausted rather than unlimited', async () => {
            prisma.coupon.findFirst.mockResolvedValue({ ...COUPON, maxRedemptions: 0 })
            prisma.order.count.mockResolvedValue(0)
            expect((await read(await orders.POST(json(body)))).status).toBe(400)
        })

        it('leaves an uncouponed order alone', async () => {
            const { status } = await read(await orders.POST(json({ ...body, couponCode: undefined })))
            expect(status).toBe(200)
            expect(prisma.order.create.mock.calls[0][0].data.couponCode).toBeNull()
            expect(prisma.order.count).not.toHaveBeenCalled()
        })
    })
})

// The status went straight from the request into the update, so a seller could
// set any value in any order, including moving DELIVERED back to ORDER_PLACED.
describe('integration: fulfilment status only moves forward', () => {
    beforeEach(() => {
        asSeller('approved', 'store_1')
        prisma.order.updateMany.mockResolvedValue({ count: 1 })
        prisma.order.findFirst.mockResolvedValue({ status: 'ORDER_PLACED' })
        prisma.orderStatusChange = { create: vi.fn().mockResolvedValue({}) }
    })

    it('advances an order and records the transition', async () => {
        const { status } = await read(await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' })))
        expect(status).toBe(200)
        expect(prisma.order.updateMany.mock.calls[0][0].data).toEqual({ status: 'SHIPPED' })
        // The row keeps only the latest value, so the log is the only record
        // that a transition happened at all.
        const logged = console.log.mock.calls
            .map(c => { try { return JSON.parse(c[0]) } catch { return null } })
            .find(l => l?.event === 'order_status_changed')
        expect(logged).toMatchObject({ orderId: 'o1', storeId: 'store_1', status: 'SHIPPED' })
    })

    it('refuses a status that is not one of the four', async () => {
        for (const bad of ['CANCELLED', 'shipped', '', 'DROP TABLE', 42, null, undefined]) {
            const { status, body } = await read(await storeOrders.POST(json({ orderId: 'o1', status: bad })))
            expect(status, `accepted ${JSON.stringify(bad)}`).toBe(400)
            expect(body.error).toBe('invalid order status')
        }
        expect(prisma.order.updateMany).not.toHaveBeenCalled()
    })

    it('enforces the direction inside the update, atomically', async () => {
        // The guard is in the update's own `where`, so even a stale read cannot
        // let a backwards transition through, and it all runs in one transaction.
        await storeOrders.POST(json({ orderId: 'o1', status: 'PROCESSING' }))
        expect(prisma.order.updateMany.mock.calls[0][0].where.status)
            .toEqual({ in: ['ORDER_PLACED', 'PROCESSING'] })
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        const commit = txCommit.mock.invocationCallOrder[0]
        expect(prisma.order.updateMany.mock.invocationCallOrder[0]).toBeLessThan(commit)
    })

    it('records what the order moved from, not merely what it moved to', async () => {
        prisma.order.findFirst.mockResolvedValue({ status: 'PROCESSING' })
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        expect(prisma.orderStatusChange.create).toHaveBeenCalledWith({
            data: { orderId: 'o1', storeId: 'store_1', from: 'PROCESSING', to: 'SHIPPED' },
        })
    })

    it('writes the history inside the same transaction as the update', async () => {
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        const commit = txCommit.mock.invocationCallOrder[0]
        expect(prisma.orderStatusChange.create.mock.invocationCallOrder[0]).toBeLessThan(commit)
    })

    it('records nothing when the status is re-sent unchanged', async () => {
        prisma.order.findFirst.mockResolvedValue({ status: 'SHIPPED' })
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        expect(prisma.orderStatusChange.create).not.toHaveBeenCalled()
    })

    it('refuses to move a delivered order backwards', async () => {
        // Nothing matched the forward-only guard, and the order does exist.
        prisma.order.updateMany.mockResolvedValue({ count: 0 })
        prisma.order.findFirst.mockResolvedValue({ status: 'DELIVERED' })

        const { status, body } = await read(await storeOrders.POST(json({ orderId: 'o1', status: 'ORDER_PLACED' })))
        expect(status).toBe(409)
        expect(body.error).toMatch(/cannot move from DELIVERED back to ORDER_PLACED/)
    })

    it('still answers 404 when the order is not the seller’s at all', async () => {
        // The two failure modes must stay distinguishable.
        prisma.order.updateMany.mockResolvedValue({ count: 0 })
        prisma.order.findFirst.mockResolvedValue(null)
        const { status } = await read(await storeOrders.POST(json({ orderId: 'someone_elses', status: 'SHIPPED' })))
        expect(status).toBe(404)
    })

    it('allows skipping ahead', async () => {
        const { status } = await read(await storeOrders.POST(json({ orderId: 'o1', status: 'DELIVERED' })))
        expect(status).toBe(200)
        expect(prisma.order.updateMany.mock.calls[0][0].where.status)
            .toEqual({ in: ['ORDER_PLACED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] })
    })

    it('keeps the payment and ownership guards alongside the new one', async () => {
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        const { where } = prisma.order.updateMany.mock.calls[0][0]
        expect(where.id).toBe('o1')
        expect(where.storeId).toBe('store_1')
        expect(where).toMatchObject(PLACED_ORDER)
    })
})

// F-20. POST /api/cart wrote the parsed request body straight into the JSONB
// column, so any signed-in user could store arbitrary JSON of unbounded size.
describe('integration: the cart column holds carts and nothing else', () => {
    beforeEach(() => {
        asShopper('u1')
        prisma.user.update.mockResolvedValue({})
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    })

    it('persists a valid cart', async () => {
        const { status } = await read(await cartApi.POST(json({ cart: { p1: 2, p2: 1 } })))
        expect(status).toBe(200)
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' }, data: { cart: { p1: 2, p2: 1 } },
        })
    })

    it('refuses the arbitrary JSON the audit was able to store', async () => {
        // The original probe stored a 1KB string and a nested object under keys
        // the UI never reads.
        const { status, body } = await read(await cartApi.POST(json({
            cart: { a: 'A'.repeat(1000), nested: { deep: [1, 2, 3] } },
        })))
        expect(status).toBe(400)
        expect(body.error).toBeDefined()
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('refuses a cart larger than any real basket', async () => {
        const huge = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}`, 1]))
        expect((await read(await cartApi.POST(json({ cart: huge })))).status).toBe(400)
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('refuses a missing or non-object cart instead of crashing', async () => {
        for (const cart of [undefined, null, 'cart', 42, []]) {
            expect((await read(await cartApi.POST(json({ cart })))).status).toBe(400)
        }
        expect((await read(await cartApi.POST(json({})))).status).toBe(400)
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('drops ids that are not products, rather than storing them', async () => {
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }])
        const { status } = await read(await cartApi.POST(json({ cart: { p1: 2, ghost: 5 } })))

        expect(status).toBe(200)
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' }, data: { cart: { p1: 2 } },
        })
    })

    it('keeps saving the cart when a product has been deleted underneath it', async () => {
        // Refusing the whole write here would leave the shopper unable to save
        // their cart at all, which is worse than forgetting a dead item.
        prisma.product.findMany.mockResolvedValue([])
        const { status } = await read(await cartApi.POST(json({ cart: { gone: 1 } })))
        expect(status).toBe(200)
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
    })

    it('does not query for products when the cart is empty', async () => {
        await cartApi.POST(json({ cart: {} }))
        expect(prisma.product.findMany).not.toHaveBeenCalled()
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
    })

    it('checks ids in one query rather than one per item', async () => {
        await cartApi.POST(json({ cart: { p1: 1, p2: 1 } }))
        expect(prisma.product.findMany).toHaveBeenCalledTimes(1)
        expect(prisma.product.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['p1', 'p2'] } })
    })
})

// The catalogue was fetched whole on every page load, and the admin dashboard
// pulled every order row into memory to produce one number.
describe('integration: queries are bounded to what is displayed', () => {
    describe('GET /api/products/[productId]', () => {
        const params = { params: Promise.resolve({ productId: 'p1' }) }

        it('returns one product without touching the catalogue', async () => {
            prisma.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Lamp', rating: [], store: {} })
            const { status, body } = await read(await productById.GET(url(`${ORIGIN}/api/products/p1`), params))

            expect(status).toBe(200)
            expect(body.product.id).toBe('p1')
            expect(prisma.product.findMany).not.toHaveBeenCalled()
        })

        it('answers 404 for a product that is not purchasable', async () => {
            // The old page searched the catalogue and, finding nothing, rendered
            // blank forever. A 404 lets the page say so.
            prisma.product.findFirst.mockResolvedValue(null)
            const { status } = await read(await productById.GET(url(`${ORIGIN}/api/products/gone`), params))
            expect(status).toBe(404)
        })

        it('applies the same visibility rules as the catalogue', async () => {
            prisma.product.findFirst.mockResolvedValue({ id: 'p1', rating: [], store: {} })
            await productById.GET(url(`${ORIGIN}/api/products/p1`), params)
            expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
                id: 'p1', inStock: true, store: SELLABLE_STORE,
            })
        })

        it('carries no seller contact details', async () => {
            prisma.product.findFirst.mockResolvedValue({ id: 'p1', rating: [], store: {} })
            await productById.GET(url(`${ORIGIN}/api/products/p1`), params)
            const { include } = prisma.product.findFirst.mock.calls[0][0]
            expect(include.store).toEqual({ select: { name: true, username: true, logo: true } })
        })
    })

    describe('GET /api/admin/dashboard', () => {
        beforeEach(() => {
            asAdmin()
            prisma.order.aggregate.mockResolvedValue({ _sum: { total: 1234.56 }, _count: 42 })
            prisma.store.count.mockResolvedValue(3)
            prisma.product.count.mockResolvedValue(9)
            prisma.order.findMany.mockResolvedValue([])
        })

        it('sums revenue in the database rather than in memory', async () => {
            const { body } = await read(await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`)))
            expect(body.dashboardData.revenue).toBe('1234.56')
            expect(body.dashboardData.orders).toBe(42)
            expect(prisma.order.aggregate).toHaveBeenCalledTimes(1)
        })

        it('does not fetch order amounts for the chart', async () => {
            // The chart counts orders per day; it never reads a total.
            await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`))
            expect(prisma.order.findMany.mock.calls[0][0].select).toEqual({ createdAt: true })
        })

        it('bounds the chart query to the window it displays', async () => {
            await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`))
            const { where } = prisma.order.findMany.mock.calls[0][0]
            expect(where.createdAt.gte).toBeInstanceOf(Date)
            const days = (Date.now() - where.createdAt.gte.getTime()) / 86400000
            expect(days).toBeGreaterThan(29)
            expect(days).toBeLessThan(31)
        })

        it('reports zero revenue on an empty platform rather than failing', async () => {
            prisma.order.aggregate.mockResolvedValue({ _sum: { total: null }, _count: 0 })
            const { body } = await read(await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`)))
            expect(body.dashboardData.revenue).toBe('0.00')
        })
    })
})

// The summary discounted the whole basket while the server discounted each
// seller's share; those disagree by a cent on a half-cent per-store total.
describe('integration: the amount charged is the sum of the orders placed', () => {
    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.order.findMany.mockResolvedValue([])
        prisma.user.updateMany.mockResolvedValue({ count: 1 })
        prisma.order.create.mockImplementation(async ({ data }) => ({ id: `o${data.storeId}` }))
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
    })

    const twoStoresAt = (price) => {
        prisma.product.findMany.mockResolvedValue([
            { id: 'p1', price, storeId: 's1' },
            { id: 'p2', price, storeId: 's2' },
        ])
        return { addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }, { id: 'p2', quantity: 1 }] }
    }

    it('charges the provider exactly the sum of the persisted order totals', async () => {
        // $10.01 in two stores at 50%: each rounds to 500, so the basket is
        // 1000. Discounting as a whole gives 1001. A member, so no shipping.
        asShopper('u1', true)
        const basket = twoStoresAt(10.01)
        prisma.coupon.findFirst.mockResolvedValue({ code: 'HALF', discount: 50, forNewUser: false, forMember: false })

        await orders.POST(json({ ...basket, paymentMethod: 'RAZORPAY', couponCode: 'HALF' }))

        const persisted = prisma.order.create.mock.calls.map(c => c[0].data.total)
        const charged = razorpayCreateLink.mock.calls[0][0].amount
        expect(persisted).toEqual([5, 5])
        expect(charged).toBe(1000)
        // The invariant: never a re-derivation, always the same integers.
        expect(charged).toBe(Math.round(persisted.reduce((a, b) => a + b, 0) * 100))
    })

    it('holds across awkward prices and quantities', async () => {
        for (const [price, discount] of [[0.07, 0], [19.99, 33], [10.005, 10], [0.01, 99], [1234.56, 7]]) {
            vi.clearAllMocks()
            asShopper('u1')
            prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
            prisma.order.findMany.mockResolvedValue([])
            prisma.user.updateMany.mockResolvedValue({ count: 1 })
            prisma.order.create.mockImplementation(async ({ data }) => ({ id: `o${data.storeId}` }))
            razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'u' })
            const basket = twoStoresAt(price)
            prisma.coupon.findFirst.mockResolvedValue({ code: 'C', discount, forNewUser: false, forMember: false })

            await orders.POST(json({ ...basket, paymentMethod: 'RAZORPAY', ...(discount ? { couponCode: 'C' } : {}) }))

            const persisted = prisma.order.create.mock.calls.map(c => c[0].data.total)
            const charged = razorpayCreateLink.mock.calls[0][0].amount
            expect(charged, `price ${price} discount ${discount}`)
                .toBe(Math.round(persisted.reduce((a, b) => a + b, 0) * 100))
            expect(Number.isInteger(charged)).toBe(true)
        }
    })

    it('persists a total that round-trips to the same cents', async () => {
        // Whatever is written to the Float column must recover exactly.
        const basket = twoStoresAt(19.99)
        await orders.POST(json({ ...basket, paymentMethod: 'COD' }))
        for (const call of prisma.order.create.mock.calls) {
            const total = call[0].data.total
            expect(Math.round(total * 100) / 100).toBe(total)
        }
    })
})

// Nothing stopped a second identical submission: no in-flight state on the
// button, no idempotency key on the endpoint.
describe('integration: a repeated checkout submission produces one basket', () => {
    const KEY = 'idem_abc123'
    const body = (over = {}) => ({
        addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD', ...over,
    })
    const withKey = (b, key = KEY) => ({
        ...json(b),
        headers: new Headers({ origin: ORIGIN, 'Idempotency-Key': key }),
    })

    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.create.mockResolvedValue({ id: 'o1' })
        prisma.user.updateMany.mockResolvedValue({ count: 1 })
        prisma.checkoutRequest.findUnique.mockResolvedValue(null)
        prisma.checkoutRequest.create.mockResolvedValue({})
        prisma.checkoutRequest.update.mockResolvedValue({})
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
    })

    it('places the order and records the submission on the first request', async () => {
        const { status } = await read(await orders.POST(withKey(body())))
        expect(status).toBe(200)
        expect(prisma.checkoutRequest.create).toHaveBeenCalledWith({
            data: { key: KEY, userId: 'u1', orderIds: ['o1'], paymentMethod: 'COD' },
        })
    })

    it('creates no second basket when the same submission arrives again', async () => {
        prisma.checkoutRequest.findUnique.mockResolvedValue({
            key: KEY, userId: 'u1', orderIds: ['o1'], paymentMethod: 'COD', sessionUrl: null,
        })
        const { status, body: res } = await read(await orders.POST(withKey(body())))

        expect(status).toBe(200)
        expect(res.message).toBe('Orders Placed Successfully')
        expect(prisma.order.create).not.toHaveBeenCalled()
        expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('returns the same payment page rather than opening a second one', async () => {
        // Two payment links for one basket is two chances to be charged.
        prisma.checkoutRequest.findUnique.mockResolvedValue({
            key: KEY, userId: 'u1', orderIds: ['o1'], paymentMethod: 'RAZORPAY',
            sessionUrl: 'https://rzp.test/i/original',
        })
        const { body: res } = await read(await orders.POST(withKey(body({ paymentMethod: 'RAZORPAY' }))))

        expect(res.session.url).toBe('https://rzp.test/i/original')
        expect(razorpayCreateLink).not.toHaveBeenCalled()
    })

    it('records the payment page so the replay has something to return', async () => {
        await orders.POST(withKey(body({ paymentMethod: 'RAZORPAY' })))
        expect(prisma.checkoutRequest.update).toHaveBeenCalledWith({
            where: { key: KEY },
            data: { sessionUrl: 'https://rzp.test/i/1' },
        })
    })

    it('refuses to guess while the first request is still creating the session', async () => {
        prisma.checkoutRequest.findUnique.mockResolvedValue({
            key: KEY, userId: 'u1', orderIds: ['o1'], paymentMethod: 'RAZORPAY', sessionUrl: null,
        })
        const { status } = await read(await orders.POST(withKey(body({ paymentMethod: 'RAZORPAY' }))))
        expect(status).toBe(409)
    })

    it('claims the key in the same transaction as the orders', async () => {
        // A claim written outside could survive a rolled-back basket and make
        // the retry replay orders that were never created.
        await orders.POST(withKey(body()))
        const commit = txCommit.mock.invocationCallOrder[0]
        expect(prisma.checkoutRequest.create.mock.invocationCallOrder[0]).toBeLessThan(commit)
    })

    it('leaves no claim behind when the checkout fails', async () => {
        prisma.$transaction.mockRejectedValueOnce(new Error('deadlock'))
        const { status } = await read(await orders.POST(withKey(body())))
        expect(status).toBe(500)
        // Nothing committed, so the retry is a fresh attempt rather than a replay.
        expect(prisma.checkoutRequest.update).not.toHaveBeenCalled()
    })

    it('releases the claim when the payment link cannot be created', async () => {
        // Otherwise the retry replays orders the compensation has deleted.
        razorpayCreateLink.mockRejectedValue(new Error('razorpay down'))
        prisma.order.deleteMany.mockResolvedValue({ count: 1 })
        prisma.checkoutRequest.delete.mockResolvedValue({})

        await orders.POST(withKey(body({ paymentMethod: 'RAZORPAY' })))
        expect(prisma.checkoutRequest.delete).toHaveBeenCalledWith({ where: { key: KEY } })
    })

    it('returns the winner when two identical submissions race', async () => {
        // Both passed the pre-check; the loser trips the primary key inside its
        // transaction and rolls back, so no second basket exists.
        prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
        prisma.checkoutRequest.findUnique
            .mockResolvedValueOnce(null)                                  // pre-check
            .mockResolvedValueOnce({ key: KEY, userId: 'u1', orderIds: ['o1'], paymentMethod: 'COD' })

        const { status, body: res } = await read(await orders.POST(withKey(body())))
        expect(status).toBe(200)
        expect(res.message).toBe('Orders Placed Successfully')
    })

    it('treats different baskets as different submissions', async () => {
        await orders.POST(withKey(body(), 'key_one'))
        await orders.POST(withKey(body(), 'key_two'))
        expect(prisma.checkoutRequest.create).toHaveBeenCalledTimes(2)
        expect(prisma.order.create).toHaveBeenCalledTimes(2)
    })

    it('still works for a client that sends no key', async () => {
        // Deployment safety: an older cached bundle must not lose the ability to
        // check out. It simply gets no deduplication.
        const { status } = await read(await orders.POST(json(body())))
        expect(status).toBe(200)
        expect(prisma.checkoutRequest.findUnique).not.toHaveBeenCalled()
        expect(prisma.checkoutRequest.create).not.toHaveBeenCalled()
    })
})

// `include: { x: true }` returns the whole row: sellers received every buyer's
// live cart, and the catalogue carried each seller's contact details and id.
describe('integration: responses carry only the fields the screen renders', () => {
    // Stands in for Prisma applying the select, so these prove the data stayed
    // behind rather than only that the query looked right.
    const project = (row, spec) => {
        if (spec === true || spec === undefined) return row
        if (spec.select) {
            return Object.fromEntries(Object.entries(spec.select)
                .filter(([, v]) => v)
                .map(([k, v]) => [k, typeof v === 'object' ? project(row[k], v) : row[k]]))
        }
        return row
    }

    const FULL_USER = {
        id: 'user_2abcCLERKID', name: 'Ada', email: 'ada@example.com',
        image: 'https://img/a.png', cart: { p1: 3, p2: 1 },
    }
    const FULL_STORE = {
        id: 's1', userId: 'user_2abcCLERKID', name: 'Shop', username: 'shop',
        description: 'd', address: '1 Main St', status: 'approved', isActive: true,
        logo: 'https://ik.test/l.webp', email: 'seller@example.com', contact: '+15550001',
        createdAt: new Date(), updatedAt: new Date(),
    }

    it('the public catalogue does not carry seller contact details or ids', async () => {
        prisma.product.findMany.mockImplementation(async ({ include }) => [
            { id: 'p1', name: 'Lamp', price: 10, store: project(FULL_STORE, include.store), rating: [] },
        ])
        const { body } = await read(await productsApi.GET(url(`${ORIGIN}/api/products`)))

        const serialised = JSON.stringify(body)
        expect(serialised).not.toContain('seller@example.com')
        expect(serialised).not.toContain('+15550001')
        expect(serialised).not.toContain('user_2abcCLERKID')
        // ...while what the product page renders survives.
        expect(body.products[0].store).toEqual({ name: 'Shop', username: 'shop', logo: 'https://ik.test/l.webp' })
    })

    it('the public store page does not carry the owner id or approval state', async () => {
        prisma.store.findUnique.mockImplementation(async ({ select }) => project({ ...FULL_STORE, Product: [] }, { select }))
        const { body } = await read(await storeData.GET(url(`${ORIGIN}/api/store/data?username=shop`)))

        expect(body.store.userId).toBeUndefined()
        expect(body.store.status).toBeUndefined()
        expect(body.store.contact).toBeUndefined()
        // The shop page renders these, including the store's own contact address.
        expect(body.store.name).toBe('Shop')
        expect(body.store.email).toBe('seller@example.com')
    })

    it('a seller never receives a buyer\'s shopping cart', async () => {
        // The sharpest part of this finding: the cart is live behavioural data
        // about a person, on a screen that only needs a name to pack a parcel.
        asSeller('approved', 'store_1')
        prisma.order.findMany.mockImplementation(async ({ include }) => [
            { id: 'o1', total: 10, user: project(FULL_USER, include.user), address: {}, orderItems: [] },
        ])
        const { body } = await read(await storeOrders.GET(url(`${ORIGIN}/api/store/orders`)))

        expect(body.orders[0].user.cart).toBeUndefined()
        expect(body.orders[0].user.id).toBeUndefined()
        expect(JSON.stringify(body)).not.toContain('user_2abcCLERKID')
        // Name and email are what the fulfilment screen shows.
        expect(body.orders[0].user).toEqual({ name: 'Ada', email: 'ada@example.com' })
    })

    it('the seller dashboard shows a reviewer without their cart or id', async () => {
        asSeller('approved', 'store_1')
        prisma.order.findMany.mockResolvedValue([])
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }])
        prisma.rating.findMany.mockImplementation(async ({ include }) => [
            { id: 'r1', rating: 5, review: 'good', user: project(FULL_USER, include.user), product: project({ id: 'p1', name: 'Lamp', category: 'Decor', description: 'x' }, include.product) },
        ])
        const { body } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))

        const review = body.dashboardData.ratings[0]
        expect(review.user).toEqual({ name: 'Ada', image: 'https://img/a.png' })
        expect(review.user.email).toBeUndefined()
        expect(JSON.stringify(body)).not.toContain('user_2abcCLERKID')
    })

    for (const [label, mod] of [['stores', adminStores], ['approve-store', adminApprove]]) {
        it(`the admin ${label} list shows the applicant without their cart`, async () => {
            asAdmin()
            prisma.store.findMany.mockImplementation(async ({ include }) => [
                { ...FULL_STORE, user: project(FULL_USER, include.user) },
            ])
            const { body } = await read(await mod.GET(url(`${ORIGIN}/api/admin/${label}`)))

            expect(body.stores[0].user.cart).toBeUndefined()
            // An admin legitimately sees the applicant's identity.
            expect(body.stores[0].user).toEqual({
                name: 'Ada', email: 'ada@example.com', image: 'https://img/a.png',
            })
        })
    }

    it('no route does currency arithmetic of its own', () => {
        // A route that multiplies or divides a price itself is doing floating
        // point arithmetic on money.
        const offenders = routeFiles()
            .filter(({ file }) => readFileSync(file, 'utf8')
                .split('\n')
                .map(line => line.replace(/\/\/.*$/, ''))
                // Formatting a value that already came from the money module is
                // the correct use; converting one by hand is not.
                .filter(line => !line.includes('fromCents') && !line.includes('toCents'))
                .some(line => /[*/]\s*100\b/.test(line) || /\.toFixed\(2\)/.test(line)))
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })

    it('no route relies on the edge runtime', () => {
        // Interactive transactions need a TCP connection, which the edge Neon
        // adapter does not provide. Checkout and the webhook both use them.
        const offenders = routeFiles()
            .filter(({ file }) => /runtime\s*=\s*['"]edge['"]/.test(readFileSync(file, 'utf8')))
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })

    it('no endpoint pulls a person or a store in wholesale', () => {
        // Both rows carry identifiers and contact details, and User carries the
        // cart. `product: true` and `address: true` are deliberately allowed:
        // a seller's own product, and the address the packing slip needs.
        const offenders = routeFiles()
            .filter(({ file }) => /\b(user|store):\s*true\b/.test(
                readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')      // ignore comments
            ))
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })
})

// F-14. The application emitted 38 unstructured console calls, had no health
// endpoint, and produced nothing that could be counted or alerted on.
describe('integration: the application can be observed', () => {
    const lastLine = (spy) => JSON.parse(spy.mock.calls.at(-1)[0])
    const lines = (spy) => spy.mock.calls.map(c => { try { return JSON.parse(c[0]) } catch { return null } }).filter(Boolean)

    describe('GET /api/health', () => {
        it('reports ok with a reachable database', async () => {
            prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
            const { status, body } = await read(await healthApi.GET())
            expect(status).toBe(200)
            expect(body.status).toBe('ok')
            expect(body.database).toBe('up')
            expect(typeof body.latencyMs).toBe('number')
        })

        it('reports 503 and degraded when the database is unreachable', async () => {
            // A monitor must be able to act on the status code alone.
            prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server at `db.neon.tech:5432`"))
            const { status, body } = await read(await healthApi.GET())
            expect(status).toBe(503)
            expect(body.status).toBe('degraded')
            expect(body.database).toBe('down')
        })

        it('never reveals why the database is unreachable', async () => {
            prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server at `db.neon.tech:5432`"))
            const { body } = await read(await healthApi.GET())
            expect(JSON.stringify(body)).not.toMatch(/neon\.tech|5432|reach database/i)
            // ...but the operator still gets it.
            expect(lastLine(console.error).event).toBe('health_database_unreachable')
        })

        it('returns exactly the four documented fields and nothing else', async () => {
            // Public and scraped. Pattern-matching catches only the secrets
            // thought of; pinning the shape catches anything added later.
            for (const setup of [
                () => prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]),
                () => prisma.$queryRaw.mockRejectedValue(new Error('down')),
            ]) {
                setup()
                const { body } = await read(await healthApi.GET())
                expect(Object.keys(body).sort()).toEqual(['database', 'latencyMs', 'status', 'version'])
            }
        })

        it('is never cached', async () => {
            // A cached health check reports the state of the last deploy.
            prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
            const res = await healthApi.GET()
            expect(res.headers.get('Cache-Control')).toBe('no-store')
        })

        it('is declared dynamic so it is not evaluated at build time', () => {
            expect(healthApi.dynamic).toBe('force-dynamic')
        })

        it('answers without authentication', async () => {
            anonymous()
            prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
            expect((await read(await healthApi.GET())).status).toBe(200)
        })
    })

    describe('structured logs', () => {
        it('emits one parseable JSON object per event', async () => {
            asShopper('u1')
            prisma.order.findMany.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }))
            await orders.GET(url(`${ORIGIN}/api/orders`))

            const line = lastLine(console.error)
            expect(line).toMatchObject({ level: 'error', event: 'api_error', code: 'P1001', message: 'boom' })
            expect(Date.parse(line.time)).not.toBeNaN()
        })

        it('gives the caller an id that ties their error to the log line', async () => {
            // The whole point of a generic message is that it says nothing. The
            // id is what makes it traceable anyway.
            asShopper('u1')
            prisma.order.findMany.mockRejectedValue(new Error('boom'))
            const { body } = await read(await orders.GET(url(`${ORIGIN}/api/orders`)))

            expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/)
            expect(lastLine(console.error).errorId).toBe(body.errorId)
        })

        it('issues a different id per failure', async () => {
            asShopper('u1')
            prisma.order.findMany.mockRejectedValue(new Error('boom'))
            const a = await read(await orders.GET(url(`${ORIGIN}/api/orders`)))
            const b = await read(await orders.GET(url(`${ORIGIN}/api/orders`)))
            expect(a.body.errorId).not.toBe(b.body.errorId)
        })

        it('records a refused card checkout as an error, not a silent 503', async () => {
            delete process.env.RAZORPAY_KEY_SECRET
            asShopper('u1')
            await orders.POST(json({ addressId: 'a1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'RAZORPAY' }))
            expect(lines(console.error).some(l => l.event === 'card_checkout_refused')).toBe(true)
        })

        it('never puts an unserialisable Error in the payload', async () => {
            // JSON.stringify(new Error()) is "{}", so the fields worth keeping
            // have to be lifted out by hand or the log says nothing.
            asShopper('u1')
            prisma.order.findMany.mockRejectedValue(new TypeError('bad thing'))
            await orders.GET(url(`${ORIGIN}/api/orders`))
            const line = lastLine(console.error)
            expect(line.name).toBe('TypeError')
            expect(line.message).toBe('bad thing')
        })
    })
})

// F-11. The coupon body was written straight to the database, and the order
// pricing path trusted whatever discount it found there.
describe('integration: coupons cannot be written or priced out of range', () => {
    const validCoupon = {
        code: 'save10', description: '10% off', discount: 10,
        forNewUser: false, forMember: false, isPublic: true, expiresAt: '2030-01-01',
    }

    describe('creation', () => {
        beforeEach(() => {
            asAdmin()
            prisma.coupon.create.mockResolvedValue({ code: 'SAVE10', expiresAt: new Date('2030-01-01') })
            inngestSend.mockResolvedValue({})
        })

        it('refuses a discount above 100 instead of storing it', async () => {
            const { status, body } = await read(await adminCoupon.POST(json({ coupon: { ...validCoupon, discount: 500 } })))
            expect(status).toBe(400)
            expect(body.error).toMatch(/discount/)
            expect(prisma.coupon.create).not.toHaveBeenCalled()
        })

        it('answers a missing code with a 400, not a crash', async () => {
            // Previously a TypeError from `coupon.code.toUpperCase()`.
            const { status, body } = await read(await adminCoupon.POST(json({ coupon: {} })))
            expect(status).toBe(400)
            expect(body.error).toMatch(/code/)
            expect(prisma.coupon.create).not.toHaveBeenCalled()
        })

        it('answers a missing body with a 400, not a crash', async () => {
            expect((await read(await adminCoupon.POST(json({})))).status).toBe(400)
            expect(prisma.coupon.create).not.toHaveBeenCalled()
        })

        it('writes only the allowlisted columns', async () => {
            await adminCoupon.POST(json({ coupon: { ...validCoupon, createdAt: '1999-01-01', code: 'save10' } }))
            const { data } = prisma.coupon.create.mock.calls[0][0]
            expect(data.createdAt).toBeUndefined()
            expect(Object.keys(data).sort()).toEqual(
                ['code', 'description', 'discount', 'expiresAt', 'forMember', 'forNewUser', 'isPublic', 'maxRedemptions'])
        })

        it('still creates a valid coupon and schedules its expiry', async () => {
            const { status } = await read(await adminCoupon.POST(json({ coupon: validCoupon })))
            expect(status).toBe(200)
            expect(prisma.coupon.create).toHaveBeenCalled()
            expect(inngestSend.mock.calls[0][0].name).toBe('app/coupon.expired')
        })
    })

    describe('pricing', () => {
        beforeEach(() => {
            asShopper('u1', true)                       // plus member: no shipping
            prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
            prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
            prisma.order.findMany.mockResolvedValue([])
            prisma.order.create.mockResolvedValue({ id: 'o1' })
            prisma.user.updateMany.mockResolvedValue({ count: 1 })
        })

        const place = () => orders.POST(json({
            addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }],
            paymentMethod: 'COD', couponCode: 'LEGACY',
        }))

        it('never produces a negative order total from a stored bad coupon', async () => {
            // Validation at creation does not retroactively fix rows that already
            // exist -- seeded coupons, or any written before the fix.
            prisma.coupon.findFirst.mockResolvedValue({ code: 'LEGACY', discount: 500, forNewUser: false, forMember: false })
            await place()
            expect(prisma.order.create.mock.calls[0][0].data.total).toBe(0)
        })

        it('prices a full 100% discount at zero, not below', async () => {
            prisma.coupon.findFirst.mockResolvedValue({ code: 'LEGACY', discount: 100, forNewUser: false, forMember: false })
            await place()
            expect(prisma.order.create.mock.calls[0][0].data.total).toBe(0)
        })

        it('leaves an ordinary discount untouched', async () => {
            prisma.coupon.findFirst.mockResolvedValue({ code: 'LEGACY', discount: 10, forNewUser: false, forMember: false })
            await place()
            expect(prisma.order.create.mock.calls[0][0].data.total).toBe(9)
        })
    })
})

// The secret was documented as something to set *after* the first deploy,
// leaving a window in which card payments could never be confirmed.
describe('integration: card checkout is refused when it cannot be confirmed', () => {
    const body = (over = {}) => ({
        addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'RAZORPAY', ...over,
    })

    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.create.mockResolvedValue({ id: 'o1' })
        prisma.user.updateMany.mockResolvedValue({ count: 1 })
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
        process.env.RAZORPAY_KEY_ID = 'rzp_test_x'
        process.env.RAZORPAY_KEY_SECRET = 'secret'
    })

    it('refuses an online order when the API keys are unset', async () => {
        delete process.env.RAZORPAY_KEY_SECRET
        const { status, body: res } = await read(await orders.POST(json(body())))
        expect(status).toBe(503)
        expect(res.error).toMatch(/temporarily unavailable/i)
    })

    it('creates no order and calls the provider not at all when refusing', async () => {
        // The point is to take no money and leave no trace, not to fail late.
        delete process.env.RAZORPAY_KEY_SECRET
        await orders.POST(json(body()))
        expect(prisma.order.create).not.toHaveBeenCalled()
        expect(prisma.$transaction).not.toHaveBeenCalled()
        expect(razorpayCreateLink).not.toHaveBeenCalled()
    })

    it('still accepts cash on delivery while card payment is unavailable', async () => {
        // Refusing cards must not take the whole storefront down with it.
        delete process.env.RAZORPAY_KEY_SECRET
        const { status, body: res } = await read(await orders.POST(json(body({ paymentMethod: 'COD' }))))
        expect(status).toBe(200)
        expect(res.message).toBe('Orders Placed Successfully')
    })

    it('allows an online order once the keys are configured', async () => {
        const { status, body: res } = await read(await orders.POST(json(body())))
        expect(status).toBe(200)
        expect(res.session.url).toBe('https://rzp.test/i/1')
    })

    it('refuses an empty-string key, not just an absent one', async () => {
        process.env.RAZORPAY_KEY_SECRET = ''
        expect((await read(await orders.POST(json(body())))).status).toBe(503)
    })
})

// F-07. The per-store orders were created as independent writes, so a failure
// partway left some committed while the buyer was told the checkout failed.
describe('integration: a basket commits as one unit', () => {
    const TWO_STORES = [
        { id: 'p1', price: 10, storeId: 's1' },
        { id: 'p2', price: 20, storeId: 's2' },
    ]
    const twoStoreBody = {
        addressId: 'addr_1',
        items: [{ id: 'p1', quantity: 1 }, { id: 'p2', quantity: 1 }],
        paymentMethod: 'COD',
    }

    beforeEach(() => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue(TWO_STORES)
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.create.mockImplementation(async () => ({ id: `o${prisma.order.create.mock.calls.length}` }))
        prisma.user.updateMany.mockResolvedValue({ count: 1 })
    })

    it('creates every per-store order inside one transaction', async () => {
        await orders.POST(json(twoStoreBody))
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(prisma.order.create).toHaveBeenCalledTimes(2)
        // Both writes and the cart clear land before the transaction returns.
        const commit = txCommit.mock.invocationCallOrder[0]
        for (const call of prisma.order.create.mock.invocationCallOrder) {
            expect(call).toBeLessThan(commit)
        }
        expect(prisma.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(commit)
    })

    it('reports failure and commits nothing when a later store fails', async () => {
        let n = 0
        prisma.order.create.mockImplementation(async () => {
            if (++n === 2) throw new Error('connection lost')
            return { id: 'o1' }
        })
        const { status } = await read(await orders.POST(json(twoStoreBody)))
        expect(status).toBe(500)
        // The rollback is the transaction's job; what matters here is that the
        // handler did not proceed to clear the cart or report success.
        expect(prisma.user.updateMany).not.toHaveBeenCalled()
    })

    it('does not clear the cart when the checkout fails', async () => {
        // The cart is the buyer's only way to retry, and clearing it after a
        // partial failure is what turned one failure into a lost basket.
        prisma.$transaction.mockRejectedValueOnce(new Error('deadlock'))
        const { status } = await read(await orders.POST(json(twoStoreBody)))
        expect(status).toBe(500)
        expect(prisma.user.updateMany).not.toHaveBeenCalled()
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('keeps the cart intact until the webhook confirms payment', async () => {
        razorpayCreateLink.mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.test/i/1' })
        const { status } = await read(await orders.POST(json({ ...twoStoreBody, paymentMethod: 'RAZORPAY' })))
        expect(status).toBe(200)
        expect(prisma.user.updateMany).not.toHaveBeenCalled()
    })

    it('undoes the orders when the payment link cannot be created', async () => {
        // Otherwise the basket becomes orders the buyer was never given a way
        // to pay for, invisible to them and permanent.
        razorpayCreateLink.mockRejectedValue(new Error('razorpay unavailable'))
        prisma.order.deleteMany.mockResolvedValue({ count: 2 })

        const { status } = await read(await orders.POST(json({ ...twoStoreBody, paymentMethod: 'RAZORPAY' })))
        expect(status).toBe(500)
        expect(prisma.order.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['o1', 'o2'] }, isPaid: false },
        })
    })

    it('never deletes an order that has been paid during cleanup', async () => {
        razorpayCreateLink.mockRejectedValue(new Error('razorpay unavailable'))
        prisma.order.deleteMany.mockResolvedValue({ count: 0 })
        await read(await orders.POST(json({ ...twoStoreBody, paymentMethod: 'RAZORPAY' })))
        expect(prisma.order.deleteMany.mock.calls[0][0].where.isPaid).toBe(false)
    })

    it('still reports the original failure if cleanup itself fails', async () => {
        razorpayCreateLink.mockRejectedValue(new Error('razorpay unavailable'))
        prisma.order.deleteMany.mockRejectedValue(new Error('database gone'))
        const { status } = await read(await orders.POST(json({ ...twoStoreBody, paymentMethod: 'RAZORPAY' })))
        expect(status).toBe(500)
    })
})

// User rows are mirrored by an asynchronous Inngest handler whose trigger lives
// outside this repository, and every authenticated write is keyed to User.
describe('integration: a write provisions its own User row', () => {
    const absentUser = () => prisma.user.findUnique.mockResolvedValue(null)
    const clerkAccount = (over = {}) => clerkGetUser.mockResolvedValue({
        firstName: 'Ada', lastName: 'Lovelace', imageUrl: 'https://img/a.png',
        emailAddresses: [{ emailAddress: 'ada@example.com' }], ...over,
    })

    const writes = [
        ['POST /api/cart', () => { prisma.user.update.mockResolvedValue({}) },
            () => cartApi.POST(json({ cart: { p1: 1 } }))],
        ['POST /api/address', () => { prisma.address.create.mockResolvedValue({ id: 'a1' }) },
            () => addressApi.POST(json({ address: { name: 'Ada', city: 'London' } }))],
        ['POST /api/rating', () => {
            prisma.order.findFirst.mockResolvedValue({ id: 'o1' })
            prisma.rating.findFirst.mockResolvedValue(null)
            prisma.rating.create.mockResolvedValue({ id: 'r1' })
        }, () => ratingApi.POST(json({ orderId: 'o1', productId: 'p1', rating: 5, review: 'great' }))],
        ['POST /api/orders', () => {
            prisma.address.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1' })
            prisma.product.findMany.mockResolvedValue([{ id: 'p1', price: 10, storeId: 's1' }])
            prisma.order.create.mockResolvedValue({ id: 'o1' })
            prisma.user.update.mockResolvedValue({})
        }, () => orders.POST(json({ addressId: 'a1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD' }))],
        ['POST /api/store/create', () => {
            prisma.store.findFirst.mockResolvedValue(null)
            imagekitUpload.mockResolvedValue({ filePath: '/l.png' })
            prisma.store.create.mockResolvedValue({ id: 'st1' })
            prisma.user.update.mockResolvedValue({})
        }, () => storeCreate.POST(form({
            name: 'S', username: 'shop', description: 'd', email: 'e@x.com',
            contact: '1', address: 'a', image: png(),
        }))],
    ]

    for (const [label, setup, call] of writes) {
        it(`${label} creates the row instead of failing on a foreign key`, async () => {
            asShopper('u1')
            absentUser()
            clerkAccount()
            setup()

            const { status } = await read(await call())
            expect(status).toBe(200)
            expect(prisma.user.create).toHaveBeenCalledWith({
                data: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', image: 'https://img/a.png' },
            })
        })
    }

    it('does not touch Clerk or write when the row already exists', async () => {
        asShopper('u1')                       // row present
        prisma.user.update.mockResolvedValue({})
        await cartApi.POST(json({ cart: { p1: 1 } }))
        expect(clerkGetUser).not.toHaveBeenCalled()
        expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it('treats a concurrent creation as success rather than an error', async () => {
        // Two first writes race, or the Inngest sync lands in between. Both
        // leave the row this exists to guarantee.
        asShopper('u1')
        absentUser()
        clerkAccount()
        prisma.user.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
        prisma.address.create.mockResolvedValue({ id: 'a1' })

        const { status } = await read(await addressApi.POST(json({ address: { name: 'Ada' } })))
        expect(status).toBe(200)
    })

    it('surfaces a genuine failure rather than continuing into the write', async () => {
        asShopper('u1')
        absentUser()
        clerkAccount()
        prisma.user.create.mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }))

        const { status } = await read(await addressApi.POST(json({ address: { name: 'Ada' } })))
        expect(status).toBe(500)
        expect(prisma.address.create).not.toHaveBeenCalled()
    })

    it('never writes the string "null null" as a name', async () => {
        // Interpolating absent Clerk name fields is what produces that, and the
        // Inngest handler still does it.
        asShopper('u1')
        absentUser()
        clerkAccount({ firstName: null, lastName: null, username: 'ada99' })
        prisma.address.create.mockResolvedValue({ id: 'a1' })

        await addressApi.POST(json({ address: { name: 'Ada' } }))
        expect(prisma.user.create.mock.calls[0][0].data.name).toBe('ada99')
    })

    it('falls back to the email, then the id, when Clerk carries no name', async () => {
        asShopper('u1')
        absentUser()
        clerkAccount({ firstName: null, lastName: null, username: null })
        prisma.address.create.mockResolvedValue({ id: 'a1' })
        await addressApi.POST(json({ address: { name: 'Ada' } }))
        expect(prisma.user.create.mock.calls[0][0].data.name).toBe('ada@example.com')

        vi.clearAllMocks()
        asShopper('u1')
        absentUser()
        clerkAccount({ firstName: null, lastName: null, username: null, emailAddresses: [] })
        prisma.address.create.mockResolvedValue({ id: 'a1' })
        await addressApi.POST(json({ address: { name: 'Ada' } }))
        expect(prisma.user.create.mock.calls[0][0].data.name).toBe('u1')
    })

    it('every route that writes a User-owned row provisions it first', () => {
        // Address, Order, Rating and Store all key to User, and user.update
        // fails outright on a missing row. Checked against the tree.
        const NEEDS_USER = /prisma\.(address|order|rating|store)\.create|prisma\.user\.update\b/
        const offenders = routeFiles()
            .filter(({ file }) => {
                const src = readFileSync(file, 'utf8')
                return NEEDS_USER.test(src) && !src.includes('ensureUser(')
            })
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })

    it('never overwrites an existing row, so a saved cart survives', async () => {
        // Provisioning must create, never update: clobbering here would wipe the
        // server-side cart of every user on their next write.
        asShopper('u1')
        prisma.user.update.mockResolvedValue({})
        await cartApi.POST(json({ cart: { p1: 2 } }))

        const updates = prisma.user.update.mock.calls.map(c => c[0])
        expect(updates).toEqual([{ where: { id: 'u1' }, data: { cart: { p1: 2 } } }])
        expect(prisma.user.create).not.toHaveBeenCalled()
    })
})

// F-05, second half. An unauthenticated caller used to receive the raw Prisma
// error, which names the database host and port.
describe('integration: internal failures never describe themselves to the caller', () => {
    // The genuine message, copied from the live probe in this audit.
    const REAL_PRISMA_ERROR = Object.assign(new Error(
        '\nInvalid `prisma.order.findMany()` invocation:\n\n\n' +
        "Can't reach database server at `ep-cool-darkness-123456.eu-central-1.aws.neon.tech:5432`\n"
    ), { code: 'P1001' })

    const LEAKS = /prisma|neon\.tech|5432|invocation|P1001|database server/i

    const cases = [
        ['GET  /api/products', () => { prisma.product.findMany.mockRejectedValue(REAL_PRISMA_ERROR) },
            () => productsApi.GET(url(`${ORIGIN}/api/products`))],
        ['GET  /api/store/data', () => { prisma.store.findUnique.mockRejectedValue(REAL_PRISMA_ERROR) },
            () => storeData.GET(url(`${ORIGIN}/api/store/data?username=shop`))],
        ['GET  /api/orders', () => { asShopper('u1'); prisma.order.findMany.mockRejectedValue(REAL_PRISMA_ERROR) },
            () => orders.GET(url(`${ORIGIN}/api/orders`))],
        ['GET  /api/cart', () => { asShopper('u1'); prisma.user.findUnique.mockRejectedValue(REAL_PRISMA_ERROR) },
            () => cartApi.GET(url(`${ORIGIN}/api/cart`))],
        ['POST /api/address', () => { asShopper('u1'); prisma.address.create.mockRejectedValue(REAL_PRISMA_ERROR) },
            () => addressApi.POST(json({ address: { name: 'n' } }))],
    ]

    for (const [label, setup, call] of cases) {
        it(`${label} returns a generic 500 that names nothing internal`, async () => {
            setup()
            const { status, body } = await read(await call())
            expect(status).toBe(500)
            expect(body.error).toBe('An internal server error occurred.')
            expect(JSON.stringify(body)).not.toMatch(LEAKS)
        })
    }

    it('still records the full error on the server', async () => {
        // Sanitising the response must not also blind the operator.
        asShopper('u1')
        prisma.order.findMany.mockRejectedValue(REAL_PRISMA_ERROR)
        await orders.GET(url(`${ORIGIN}/api/orders`))
        const logged = JSON.parse(console.error.mock.calls.at(-1)[0])
        expect(logged.event).toBe('api_error')
        expect(logged.message).toContain('neon.tech')   // the detail withheld from the caller
        expect(logged.code).toBe('P1001')
        expect(logged.stack).toBeTruthy()
    })

    it('no route hand-rolls an error response', () => {
        // The cases above prove the helper is safe; this proves every handler
        // delegates to it, rather than only those someone remembered to test.
        const offenders = routeFiles()
            .filter(({ file }) => /error:\s*error\./.test(readFileSync(file, 'utf8')))
            .map(({ route }) => route)
        expect(offenders).toEqual([])
    })

    it('leaves deliberate validation messages intact', async () => {
        // Only unhandled failures are generic. Messages the handlers choose to
        // return are part of the contract and must survive.
        asShopper('u1')
        const { status, body } = await read(await orders.POST(json({ addressId: 'a', items: [], paymentMethod: 'COD' })))
        expect(status).toBe(400)
        expect(body.error).toBe('missing order details.')
    })
})

describe('integration: buyer and seller agree on which orders count', () => {
    it('both order lists filter on the same shared predicate', async () => {
        asShopper('u1')
        prisma.order.findMany.mockResolvedValue([])
        await orders.GET(url(`${ORIGIN}/api/orders`))
        const buyerWhere = prisma.order.findMany.mock.calls[0][0].where

        vi.clearAllMocks()
        asSeller('approved', 'store_1')
        prisma.order.findMany.mockResolvedValue([])
        await storeOrders.GET(url(`${ORIGIN}/api/store/orders`))
        const sellerWhere = prisma.order.findMany.mock.calls[0][0].where

        // Same predicate, differing only in who the rows are scoped to.
        expect(buyerWhere.OR).toEqual(sellerWhere.OR)
        expect(buyerWhere).toMatchObject(PLACED_ORDER)
        expect(sellerWhere).toMatchObject(PLACED_ORDER)
    })

    // The same invariant for the money figures: earnings and revenue must
    // describe the same set of orders as the lists.
    it('every order read across buyer, seller and both dashboards shares the predicate', async () => {
        const whereOf = async (run, setup = () => {}) => {
            vi.clearAllMocks()
            prisma.order.findMany.mockResolvedValue([])
            prisma.order.count.mockResolvedValue(0)
            prisma.order.aggregate.mockResolvedValue({ _sum: { total: 0 }, _count: 0 })
            prisma.product.findMany.mockResolvedValue([])
            prisma.product.count.mockResolvedValue(0)
            prisma.store.count.mockResolvedValue(0)
            prisma.rating.findMany.mockResolvedValue([])
            setup()
            await run()
            return prisma.order.findMany.mock.calls[0][0].where
        }

        const wheres = {
            buyerList: await whereOf(() => orders.GET(url(`${ORIGIN}/api/orders`)), () => asShopper('u1')),
            sellerList: await whereOf(() => storeOrders.GET(url(`${ORIGIN}/api/store/orders`)), () => asSeller('approved', 'store_1')),
            sellerEarnings: await whereOf(() => storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)), () => asSeller('approved', 'store_1')),
            adminRevenue: await whereOf(() => adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`)), () => asAdmin()),
        }

        for (const [name, where] of Object.entries(wheres)) {
            expect(where, `${name} lost the payment predicate`).toMatchObject(PLACED_ORDER)
            expect(where.OR, `${name} forked its own copy`).toEqual(PLACED_ORDER.OR)
        }
    })

    it('counts a COD order but not an unconfirmed online one', () => {
        // The predicate's meaning, asserted directly rather than through a query.
        const [cod, onlinePaid] = PLACED_ORDER.OR
        expect(cod).toEqual({ paymentMethod: 'COD' })
        expect(onlinePaid).toEqual({ AND: [{ paymentMethod: { in: ['STRIPE', 'RAZORPAY'] } }, { isPaid: true }] })
    })
})

describe('integration: sellers act only on their own store', () => {
    beforeEach(() => asSeller('approved', 'store_1'))

    it('scopes the dashboard to the resolved store', async () => {
        prisma.order.findMany.mockResolvedValue([{ total: 10 }, { total: 20 }])
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }])
        prisma.rating.findMany.mockResolvedValue([])
        const { body } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))
        expect(body.dashboardData.totalEarnings).toBe(30)
        expect(prisma.order.findMany.mock.calls[0][0].where.storeId).toBe('store_1')
    })

    // F-04. Earnings summed the raw order table, so an abandoned online checkout
    // counted as money the seller had made.
    it('excludes unpaid online orders from earnings and the order count', async () => {
        const { where } = await (async () => {
            prisma.order.findMany.mockResolvedValue([])
            prisma.product.findMany.mockResolvedValue([])
            prisma.rating.findMany.mockResolvedValue([])
            await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`))
            return prisma.order.findMany.mock.calls[0][0]
        })()
        expect(where.storeId).toBe('store_1')
        expect(where).toMatchObject(PLACED_ORDER)
    })

    it('reports earnings equal to the sum the order list would show', async () => {
        // The query is what excludes the unpaid rows, so the totals follow from
        // the same set the seller can actually see.
        prisma.order.findMany.mockResolvedValue([{ total: 100 }])
        prisma.product.findMany.mockResolvedValue([])
        prisma.rating.findMany.mockResolvedValue([])
        const { body } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))
        expect(body.dashboardData.totalEarnings).toBe(100)
        expect(body.dashboardData.totalOrders).toBe(1)
        expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject(PLACED_ORDER)
    })

    it('scopes an order status update to the seller store', async () => {
        prisma.order.updateMany.mockResolvedValue({ count: 1 })
        prisma.order.findFirst.mockResolvedValue({ status: 'ORDER_PLACED' })
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        const { where } = prisma.order.updateMany.mock.calls[0][0]
        expect(where.id).toBe('o1')
        expect(where.storeId).toBe('store_1')
    })

    // F-03. The seller list once had no payment predicate at all, so every
    // abandoned online checkout showed up as an order to pack and ship.
    it('hides unpaid online orders from the seller order list', async () => {
        prisma.order.findMany.mockResolvedValue([])
        await storeOrders.GET(url(`${ORIGIN}/api/store/orders`))
        const { where } = prisma.order.findMany.mock.calls[0][0]
        expect(where.storeId).toBe('store_1')
        expect(where).toMatchObject(PLACED_ORDER)
    })

    it('refuses to advance the status of an unpaid online order', async () => {
        // No row matches once the payment predicate is applied, so the
        // transaction finds nothing and never reaches the write at all.
        prisma.order.updateMany.mockResolvedValue({ count: 0 })
        prisma.order.findFirst.mockResolvedValue(null)
        const { status } = await read(await storeOrders.POST(json({ orderId: 'unpaid', status: 'SHIPPED' })))

        expect(status).toBe(404)
        expect(prisma.order.findFirst.mock.calls[0][0].where).toMatchObject(PLACED_ORDER)
        expect(prisma.order.updateMany).not.toHaveBeenCalled()
        expect(prisma.orderStatusChange.create).not.toHaveBeenCalled()
    })

    it('applies the payment guard in the same statement as the write', async () => {
        // The guard is in the update's own `where`, inside one transaction, so
        // nothing can change between examination and write.
        prisma.order.updateMany.mockResolvedValue({ count: 1 })
        prisma.order.findFirst.mockResolvedValue({ status: 'ORDER_PLACED' })
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))

        expect(prisma.order.update).not.toHaveBeenCalled()
        expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
        expect(prisma.order.updateMany.mock.calls[0][0].where).toMatchObject(PLACED_ORDER)
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    })

    it('rejects a status update with no orderId instead of updating the whole store', async () => {
        // Prisma drops an undefined key from a where clause, so an unguarded
        // updateMany here would rewrite the status of every order in the store.
        const { status } = await read(await storeOrders.POST(json({ status: 'DELIVERED' })))
        expect(status).toBe(400)
        expect(prisma.order.updateMany).not.toHaveBeenCalled()
    })

    it("refuses to toggle stock on a product the seller does not own", async () => {
        prisma.product.findFirst.mockResolvedValue(null)
        const { status } = await read(await storeStock.POST(json({ productId: 'not_mine' })))
        expect(status).toBe(404)
        expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({ id: 'not_mine', storeId: 'store_1' })
        expect(prisma.product.update).not.toHaveBeenCalled()
    })

    it('toggles stock on an owned product', async () => {
        prisma.product.findFirst.mockResolvedValue({ id: 'p1', inStock: true })
        prisma.product.update.mockResolvedValue({})
        await storeStock.POST(json({ productId: 'p1' }))
        expect(prisma.product.update.mock.calls[0][0].data).toEqual({ inStock: false })
    })

    const badPrices = [
        ['negative price', { mrp: '40', price: '-29' }],
        ['negative mrp', { mrp: '-40', price: '29' }],
        ['price above mrp', { mrp: '20', price: '29' }],
        ['non-numeric price', { mrp: '40', price: 'free' }],
    ]
    for (const [label, fields] of badPrices) {
        it(`refuses a product with ${label}`, async () => {
            const { status } = await read(await storeProduct.POST(form({
                name: 'n', description: 'd', category: 'c', images: [png()], ...fields,
            })))
            expect(status).toBe(400)
            expect(prisma.product.create).not.toHaveBeenCalled()
        })
    }

    it('refuses a product with no images', async () => {
        const { status, body } = await read(await storeProduct.POST(form({
            name: 'n', description: 'd', mrp: '40', price: '29', category: 'c',
        })))
        expect(status).toBe(400)
        expect(body.error).toBe('missing product details')
    })

    it('uploads every supplied image and stores the optimised URLs', async () => {
        imagekitUpload.mockResolvedValue({ filePath: '/products/p.png' })
        prisma.product.create.mockResolvedValue({ id: 'p1' })
        await storeProduct.POST(form({
            name: 'n', description: 'd', mrp: '40', price: '29', category: 'c',
            images: [png('1.png'), png('2.png')],
        }))
        expect(imagekitUpload).toHaveBeenCalledTimes(2)
        expect(prisma.product.create.mock.calls[0][0].data.images).toEqual([
            'https://ik.test/img.webp', 'https://ik.test/img.webp',
        ])
    })

    it('parses the AI response and rejects malformed JSON', async () => {
        openaiCreate.mockResolvedValue({ choices: [{ message: { content: '```json\n{"name":"Lamp","description":"d"}\n```' } }] })
        const ok = await read(await storeAi.POST(json({ base64Image: PNG_BASE64, mimeType: 'image/png' })))
        expect(ok.status).toBe(200)
        expect(ok.body.name).toBe('Lamp')

        openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'not json at all' } }] })
        const bad = await read(await storeAi.POST(json({ base64Image: PNG_BASE64, mimeType: 'image/png' })))
        expect(bad.status).toBe(500)
    })
})

describe('integration: admin operations', () => {
    beforeEach(() => asAdmin())

    it('lists only pending and rejected stores for approval', async () => {
        prisma.store.findMany.mockResolvedValue([])
        await adminApprove.GET(url(`${ORIGIN}/api/admin/approve-store`))
        expect(prisma.store.findMany.mock.calls[0][0].where).toEqual({ status: { in: ['pending', 'rejected'] } })
    })

    it('rejecting a store deactivates it as well as marking it', async () => {
        // A store that was approved, activated and then rejected would otherwise
        // keep isActive and its products would stay on the storefront.
        prisma.store.update.mockResolvedValue({})
        await adminApprove.POST(json({ storeId: 's1', status: 'rejected' }))
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ status: 'rejected', isActive: false })
    })

    it('upper-cases a new coupon code and schedules its expiry job', async () => {
        prisma.coupon.create.mockResolvedValue({ code: 'SAVE10', expiresAt: new Date('2030-01-01') })
        inngestSend.mockResolvedValue({})
        await adminCoupon.POST(json({ coupon: {
            code: 'save10', discount: 10, description: '10% off', expiresAt: '2030-01-01',
        } }))
        expect(prisma.coupon.create.mock.calls[0][0].data.code).toBe('SAVE10')
        expect(inngestSend.mock.calls[0][0].name).toBe('app/coupon.expired')
        expect(inngestSend.mock.calls[0][0].data.code).toBe('SAVE10')
    })

    it('aggregates dashboard totals across the platform', async () => {
        prisma.order.aggregate.mockResolvedValue({ _sum: { total: 15 }, _count: 2 })
        prisma.store.count.mockResolvedValue(1)
        prisma.product.count.mockResolvedValue(3)
        prisma.order.findMany.mockResolvedValue([{ createdAt: 'x' }, { createdAt: 'y' }])
        const { body } = await read(await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`)))
        expect(body.dashboardData.revenue).toBe('15.00')
        expect(body.dashboardData.orders).toBe(2)
    })

    // F-04. Platform revenue counted every row in the order table, so it was
    // inflated by the checkout abandonment rate.
    it('excludes unpaid online orders from revenue, the count and the chart', async () => {
        prisma.order.aggregate.mockResolvedValue({ _sum: { total: 0 }, _count: 0 })
        prisma.store.count.mockResolvedValue(0)
        prisma.product.count.mockResolvedValue(0)
        prisma.order.findMany.mockResolvedValue([])
        await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`))

        // Revenue and the headline count come from one aggregate...
        expect(prisma.order.aggregate.mock.calls[0][0].where).toMatchObject(PLACED_ORDER)
        // ...and the chart query must agree with it.
        expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject(PLACED_ORDER)
    })

    it('counts stores and products without an order predicate', async () => {
        // Guards against a copy-paste that filters the wrong model.
        prisma.order.aggregate.mockResolvedValue({ _sum: { total: 0 }, _count: 0 })
        prisma.store.count.mockResolvedValue(0)
        prisma.product.count.mockResolvedValue(0)
        prisma.order.findMany.mockResolvedValue([])
        await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`))
        expect(prisma.store.count).toHaveBeenCalledWith()
        expect(prisma.product.count).toHaveBeenCalledWith()
    })

    it('refuses to toggle a store that does not exist', async () => {
        prisma.store.findUnique.mockResolvedValue(null)
        const { status } = await read(await adminToggle.POST(json({ storeId: 'ghost' })))
        expect(status).toBe(400)
        expect(prisma.store.update).not.toHaveBeenCalled()
    })
})

describe('integration: database failures degrade safely', () => {
    it('a seller endpoint fails closed when the auth query throws', async () => {
        getAuth.mockReturnValue({ userId: 'u1', has: () => false })
        prisma.user.findUnique.mockRejectedValue(new Error('connection lost'))
        const { status } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))
        expect(status).toBe(401)
    })

    it('an admin endpoint fails closed when Clerk is unavailable', async () => {
        getAuth.mockReturnValue({ userId: 'admin_1', has: () => false })
        clerkGetUser.mockRejectedValue(new Error('clerk down'))
        const { status } = await read(await adminIsAdmin.GET(url(`${ORIGIN}/api/admin/is-admin`)))
        expect(status).toBe(401)
    })

    it('a write failure mid-checkout does not report success', async () => {
        asShopper('u1')
        prisma.address.findFirst.mockResolvedValue({ id: 'addr_1', userId: 'u1' })
        prisma.product.findMany.mockResolvedValue([{ id: 'p1', storeId: 's1', price: 10 }])
        prisma.order.findMany.mockResolvedValue([])
        prisma.order.create.mockRejectedValue(new Error('deadlock'))
        const { status } = await read(await orders.POST(json({
            addressId: 'addr_1', items: [{ id: 'p1', quantity: 1 }], paymentMethod: 'COD',
        })))
        expect(status).toBe(500)
        expect(prisma.user.update).not.toHaveBeenCalled()
    })
})

// Reconciliation is the only thing that confirms an online payment, so what it
// logs is what the §5 alerts are built on.
describe('integration: reconciliation reports itself as routine work', () => {
    const step = { run: async (_name, fn) => fn() }
    const lines = (spy) => spy.mock.calls.map(c => { try { return JSON.parse(c[0]) } catch { return null } }).filter(Boolean)

    beforeEach(() => {
        process.env.RAZORPAY_KEY_ID = 'rzp_test_x'
        process.env.RAZORPAY_KEY_SECRET = 'secret'
        razorpayListLinks.mockResolvedValue({
            payment_links: [{
                id: 'plink_1', status: 'paid',
                notes: { orderIds: 'o1', userId: 'u1', appId: 'gocart' },
            }],
        })
    })

    it('records a confirmed payment at info, not error', async () => {
        prisma.order.updateMany.mockResolvedValue({ count: 1 })
        await jobs.reconcileRazorpayPayments.handler({ step })

        // Every successful payment passes through here now. Logging it as an
        // error would page someone on each one and bury the real failures.
        expect(lines(console.error).some(l => l.event === 'payments_reconciled')).toBe(false)
        expect(lines(console.log).find(l => l.event === 'payments_reconciled'))
            .toMatchObject({ repairedCount: 1, orders: ['o1'] })
    })

    it('still reports a quiet sweep', async () => {
        prisma.order.updateMany.mockResolvedValue({ count: 0 })
        await jobs.reconcileRazorpayPayments.handler({ step })
        expect(lines(console.log).find(l => l.event === 'payments_reconciled'))
            .toMatchObject({ repairedCount: 0 })
    })
})
