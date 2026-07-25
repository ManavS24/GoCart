// Modules wired together. Only external boundaries are mocked (Prisma, Clerk,
// Stripe, ImageKit, OpenAI, Inngest); real middleware and route handlers run.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
    store: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    product: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    order: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    rating: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    address: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    coupon: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    processedWebhookEvent: { create: vi.fn() },
}
const getAuth = vi.fn()
const clerkGetUser = vi.fn()
const stripeConstructEvent = vi.fn()
const stripeListSessions = vi.fn()
const stripeCreateSession = vi.fn()
const imagekitUpload = vi.fn()
const inngestSend = vi.fn()
const openaiCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({ default: prisma }))
vi.mock('@clerk/nextjs/server', () => ({
    getAuth: (...a) => getAuth(...a),
    clerkClient: async () => ({ users: { getUser: (...a) => clerkGetUser(...a) } }),
}))
// stripe-node is callable with and without `new`; the double must match.
vi.mock('stripe', () => {
    function FakeStripe() {
        const self = this instanceof FakeStripe ? this : Object.create(FakeStripe.prototype)
        self.webhooks = { constructEvent: (...a) => stripeConstructEvent(...a) }
        self.checkout = { sessions: { list: (...a) => stripeListSessions(...a), create: (...a) => stripeCreateSession(...a) } }
        return self
    }
    return { default: FakeStripe }
})
vi.mock('@/configs/imageKit', () => ({
    default: () => ({ upload: (...a) => imagekitUpload(...a), url: () => 'https://ik.test/img.webp' }),
}))
vi.mock('@/configs/openai', () => ({
    getOpenAI: () => ({ chat: { completions: { create: (...a) => openaiCreate(...a) } } }),
}))
vi.mock('@/inngest/client', () => ({ inngest: { send: (...a) => inngestSend(...a) } }))

const orders = await import('@/app/api/orders/route')
const cartApi = await import('@/app/api/cart/route')
const addressApi = await import('@/app/api/address/route')
const couponApi = await import('@/app/api/coupon/route')
const ratingApi = await import('@/app/api/rating/route')
const productsApi = await import('@/app/api/products/route')
const stripeApi = await import('@/app/api/stripe/route')
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
const png = (n = 'a.png') => new File([new Uint8Array([1])], n, { type: 'image/png' })

const asShopper = (userId = 'u1', plus = false) =>
    getAuth.mockReturnValue({ userId, has: () => plus })
// Drives the real authSeller via the mocked user row.
const asSeller = (status = 'approved', storeId = 'store_1', userId = 'u1') => {
    getAuth.mockReturnValue({ userId, has: () => false })
    prisma.user.findUnique.mockResolvedValue({ id: userId, store: { id: storeId, status } })
}
// Drives the real authAdmin against ADMIN_EMAIL.
const asAdmin = (email = 'admin@example.com') => {
    getAuth.mockReturnValue({ userId: 'admin_1', has: () => false })
    clerkGetUser.mockResolvedValue({ emailAddresses: [{ emailAddress: email }] })
}
const anonymous = () => getAuth.mockReturnValue({ userId: null, has: () => false })

// Model methods actually invoked, for "did this leak?" assertions.
const readsPerformed = () =>
    Object.entries(prisma).flatMap(([model, methods]) =>
        Object.entries(methods).filter(([, fn]) => fn.mock.calls.length > 0).map(([m]) => `${model}.${m}`))

beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ADMIN_EMAIL = 'admin@example.com'
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
            .toEqual({ inStock: true, store: { isActive: true } })
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
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
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

    it('routes a STRIPE order to a checkout session instead of clearing the cart', async () => {
        stripeCreateSession.mockResolvedValue({ url: 'https://stripe.test/s/1' })
        const { status, body: res } = await read(await orders.POST(json(body({ paymentMethod: 'STRIPE' }))))
        expect(status).toBe(200)
        expect(res.session.url).toBe('https://stripe.test/s/1')
        // Cleared by the webhook only once payment succeeds.
        expect(prisma.user.update).not.toHaveBeenCalled()

        const session = stripeCreateSession.mock.calls[0][0]
        expect(session.metadata.appId).toBe('gocart')
        expect(session.metadata.orderIds).toBe('order_1')
        expect(session.line_items[0].price_data.unit_amount).toBe(20500)
        expect(session.success_url).toBe(`${ORIGIN}/loading?nextUrl=orders`)
    })

    it('falls back to the request origin when the Origin header is absent', async () => {
        stripeCreateSession.mockResolvedValue({ url: 'x' })
        await orders.POST({
            json: async () => body({ paymentMethod: 'STRIPE' }),
            headers: new Headers(), nextUrl: new URL(ORIGIN), url: ORIGIN,
        })
        expect(stripeCreateSession.mock.calls[0][0].success_url).toBe(`${ORIGIN}/loading?nextUrl=orders`)
    })
})

describe('integration: stripe webhook completes the order lifecycle', () => {
    const hook = () => ({ text: async () => '{}', headers: new Headers({ 'stripe-signature': 'sig' }) })
    const evt = (type, id = 'evt_1') => ({ id, type, data: { object: { id: 'pi_1' } } })
    const META = { orderIds: 'o1,o2', userId: 'u1', appId: 'gocart' }

    beforeEach(() => {
        prisma.processedWebhookEvent.create.mockResolvedValue({})
        stripeListSessions.mockResolvedValue({ data: [{ metadata: META }] })
    })

    it('rejects an unverifiable signature before any write', async () => {
        stripeConstructEvent.mockImplementation(() => { throw new Error('Invalid signature') })
        const { status } = await read(await stripeApi.POST(hook()))
        expect(status).toBe(400)
        expect(prisma.processedWebhookEvent.create).not.toHaveBeenCalled()
    })

    it('marks orders paid and clears the cart on success', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.succeeded'))
        const { status } = await read(await stripeApi.POST(hook()))
        expect(status).toBe(200)
        expect(prisma.order.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['o1', 'o2'] } }, data: { isPaid: true } })
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { cart: {} } })
    })

    it('deletes only unpaid orders on cancellation', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.canceled'))
        await stripeApi.POST(hook())
        expect(prisma.order.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['o1', 'o2'] }, isPaid: false } })
    })

    it('claims the event id before mutating anything', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.succeeded'))
        await stripeApi.POST(hook())
        expect(prisma.processedWebhookEvent.create.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.order.updateMany.mock.invocationCallOrder[0])
    })

    it('ignores a replayed delivery without touching orders', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.canceled'))
        prisma.processedWebhookEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
        const { status, body } = await read(await stripeApi.POST(hook()))
        expect(status).toBe(200)
        expect(body.duplicate).toBe(true)
        expect(prisma.order.deleteMany).not.toHaveBeenCalled()
        expect(stripeListSessions).not.toHaveBeenCalled()
    })

    it('surfaces a non-duplicate ledger failure', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.succeeded'))
        prisma.processedWebhookEvent.create.mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }))
        expect((await read(await stripeApi.POST(hook()))).status).toBe(400)
        expect(prisma.order.updateMany).not.toHaveBeenCalled()
    })

    it('ignores sessions belonging to another app', async () => {
        stripeConstructEvent.mockReturnValue(evt('payment_intent.succeeded'))
        stripeListSessions.mockResolvedValue({ data: [{ metadata: { ...META, appId: 'other' } }] })
        expect((await read(await stripeApi.POST(hook()))).status).toBe(200)
        expect(prisma.order.updateMany).not.toHaveBeenCalled()
    })

    it('survives a missing session, missing metadata and unknown event types', async () => {
        for (const [setup, type] of [
            [() => stripeListSessions.mockResolvedValue({ data: [] }), 'payment_intent.succeeded'],
            [() => stripeListSessions.mockResolvedValue({ data: [{ metadata: { appId: 'gocart' } }] }), 'payment_intent.succeeded'],
            [() => {}, 'charge.refunded'],
        ]) {
            vi.clearAllMocks()
            prisma.processedWebhookEvent.create.mockResolvedValue({})
            stripeListSessions.mockResolvedValue({ data: [{ metadata: META }] })
            setup()
            stripeConstructEvent.mockReturnValue(evt(type))
            expect((await read(await stripeApi.POST(hook()))).status).toBe(200)
            expect(prisma.order.updateMany).not.toHaveBeenCalled()
        }
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
        expect(prisma.order.findFirst).toHaveBeenCalledWith({
            where: { id: 'o1', userId: 'u1', orderItems: { some: { productId: 'p1' } } },
        })
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
        expect(prisma.product.findMany.mock.calls[0][0].where.store).toEqual({ isActive: true })
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
        expect(prisma.store.findUnique.mock.calls[0][0].where).toEqual({ username: 'happyshop', isActive: true })
    })
})

describe('integration: cart and address persistence', () => {
    beforeEach(() => asShopper('u1'))

    it('round-trips the cart for a signed-in shopper', async () => {
        prisma.user.update.mockResolvedValue({})
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

describe('integration: sellers act only on their own store', () => {
    beforeEach(() => asSeller('approved', 'store_1'))

    it('scopes the dashboard to the resolved store', async () => {
        prisma.order.findMany.mockResolvedValue([{ total: 10 }, { total: 20 }])
        prisma.product.findMany.mockResolvedValue([{ id: 'p1' }])
        prisma.rating.findMany.mockResolvedValue([])
        const { body } = await read(await storeDashboard.GET(url(`${ORIGIN}/api/store/dashboard`)))
        expect(body.dashboardData.totalEarnings).toBe(30)
        expect(prisma.order.findMany).toHaveBeenCalledWith({ where: { storeId: 'store_1' } })
    })

    it('scopes an order status update to the seller store', async () => {
        prisma.order.update.mockResolvedValue({})
        await storeOrders.POST(json({ orderId: 'o1', status: 'SHIPPED' }))
        expect(prisma.order.update.mock.calls[0][0].where).toEqual({ id: 'o1', storeId: 'store_1' })
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
        const ok = await read(await storeAi.POST(json({ base64Image: 'x', mimeType: 'image/png' })))
        expect(ok.status).toBe(200)
        expect(ok.body.name).toBe('Lamp')

        openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'not json at all' } }] })
        const bad = await read(await storeAi.POST(json({ base64Image: 'x', mimeType: 'image/png' })))
        expect(bad.status).toBe(400)
    })
})

describe('integration: admin operations', () => {
    beforeEach(() => asAdmin())

    it('lists only pending and rejected stores for approval', async () => {
        prisma.store.findMany.mockResolvedValue([])
        await adminApprove.GET(url(`${ORIGIN}/api/admin/approve-store`))
        expect(prisma.store.findMany.mock.calls[0][0].where).toEqual({ status: { in: ['pending', 'rejected'] } })
    })

    it('rejecting a store does not activate it', async () => {
        prisma.store.update.mockResolvedValue({})
        await adminApprove.POST(json({ storeId: 's1', status: 'rejected' }))
        expect(prisma.store.update.mock.calls[0][0].data).toEqual({ status: 'rejected' })
    })

    it('upper-cases a new coupon code and schedules its expiry job', async () => {
        prisma.coupon.create.mockResolvedValue({ code: 'SAVE10', expiresAt: new Date('2030-01-01') })
        inngestSend.mockResolvedValue({})
        await adminCoupon.POST(json({ coupon: { code: 'save10', discount: 10 } }))
        expect(prisma.coupon.create.mock.calls[0][0].data.code).toBe('SAVE10')
        expect(inngestSend.mock.calls[0][0].name).toBe('app/coupon.expired')
        expect(inngestSend.mock.calls[0][0].data.code).toBe('SAVE10')
    })

    it('aggregates dashboard totals across the platform', async () => {
        prisma.order.count.mockResolvedValue(2)
        prisma.store.count.mockResolvedValue(1)
        prisma.product.count.mockResolvedValue(3)
        prisma.order.findMany.mockResolvedValue([{ total: 10.5, createdAt: 'x' }, { total: 4.5, createdAt: 'y' }])
        const { body } = await read(await adminDashboard.GET(url(`${ORIGIN}/api/admin/dashboard`)))
        expect(body.dashboardData.revenue).toBe('15.00')
        expect(body.dashboardData.orders).toBe(2)
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
        expect(status).toBe(400)
        expect(prisma.user.update).not.toHaveBeenCalled()
    })
})
