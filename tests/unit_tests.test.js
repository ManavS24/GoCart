// Every module in isolation; Prisma, Clerk and axios are mocked at the boundary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'

const prisma = {
    user: { findUnique: vi.fn() },
}
const getUser = vi.fn()
const axiosGet = vi.fn()
const axiosPost = vi.fn()

vi.mock('@/lib/prisma', () => ({ default: prisma }))
vi.mock('@clerk/nextjs/server', () => ({
    clerkClient: async () => ({ users: { getUser: (...a) => getUser(...a) } }),
    getAuth: vi.fn(),
}))
vi.mock('axios', () => ({
    default: { get: (...a) => axiosGet(...a), post: (...a) => axiosPost(...a) },
}))

const { safeInternalPath } = await import('@/lib/safeInternalPath')
const { default: authAdmin } = await import('@/middlewares/authAdmin')
const { default: authSeller } = await import('@/middlewares/authSeller')
const { makeStore } = await import('@/lib/store')
const { parseCouponInput } = await import('@/lib/couponInput')
const { default: nextConfig } = await import('../next.config.mjs')
const { toCents, fromCents, sumCents, percentOfCents, SHIPPING_CENTS } = await import('@/lib/money')
const { priceBasket } = await import('@/lib/checkoutPricing')
const { parseCartInput, MAX_CART_ITEMS, MAX_QUANTITY } = await import('@/lib/cartInput')
const { parseOrderStatus, ORDER_STATUS_SEQUENCE } = await import('@/lib/orderStatus')
const { rateLimit, __resetRateLimits } = await import('@/lib/rateLimit')
const { isAllowedImageType, base64Bytes, bytesMatchClaimedType, sniffImageType, MAX_IMAGE_BYTES, MAX_IMAGES_PER_PRODUCT } = await import('@/lib/uploadLimits')
const { OrderStatus } = await import('@prisma/client')
const { assets, categories, ourSpecsData } = await import('@/assets/assets')

const cart = await import('@/lib/features/cart/cartSlice')
const product = await import('@/lib/features/product/productSlice')
const addressSlice = await import('@/lib/features/address/addressSlice')
const ratingSlice = await import('@/lib/features/rating/ratingSlice')

const silence = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('safeInternalPath', () => {
    it('accepts the value the checkout flow actually sends', () => {
        expect(safeInternalPath('orders')).toBe('/orders')
    })

    it('normalises a single leading slash', () => {
        expect(safeInternalPath('/orders')).toBe('/orders')
    })

    it('allows nested internal paths', () => {
        expect(safeInternalPath('store/orders')).toBe('/store/orders')
        expect(safeInternalPath('/store/add-product')).toBe('/store/add-product')
    })

    // "//evil.com" is the protocol-relative attack.
    it('rejects repeated leading slashes', () => {
        expect(safeInternalPath('//orders')).toBeNull()
        expect(safeInternalPath('///orders')).toBeNull()
    })

    const hostile = [
        ['absolute http URL', 'http://evil.com'],
        ['absolute https URL', 'https://evil.com/phish'],
        ['protocol-relative URL', '//evil.com'],
        ['backslash variant', '\\\\evil.com'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['data scheme', 'data:text/html,<script>'],
        ['userinfo trick', 'https://shop.test@evil.com'],
        ['encoded slashes', '%2F%2Fevil.com'],
        ['bare host', 'evil.com'],
        ['whitespace-padded URL', '  https://evil.com  '],
        ['tab-obfuscated scheme', 'ja\tvascript:alert(1)'],
        ['newline injection', 'orders\nhttps://evil.com'],
        ['parent traversal', '../../etc/passwd'],
        ['query smuggling', 'orders?next=https://evil.com'],
        ['fragment smuggling', 'orders#//evil.com'],
    ]

    for (const [label, value] of hostile) {
        it(`rejects ${label}`, () => expect(safeInternalPath(value)).toBeNull())
    }

    it('rejects empty and non-string input', () => {
        for (const v of [null, undefined, '', '   ', 42, {}, [], true, NaN]) {
            expect(safeInternalPath(v)).toBeNull()
        }
    })

    it('never returns a value that leaves the origin', () => {
        const base = 'https://shop.test'
        for (const [, value] of hostile) {
            const r = safeInternalPath(value)
            if (r !== null) expect(new URL(r, base).origin).toBe(base)
        }
    })
})

describe('authAdmin', () => {
    // As the Backend API returns it: addresses carry an id and a verification
    // record, and the primary is named by id rather than implied by position.
    const asUser = (email) => ({
        primaryEmailAddressId: 'idn_primary',
        emailAddresses: [
            { id: 'idn_primary', emailAddress: email, verification: { status: 'verified' } },
        ],
    })

    beforeEach(() => {
        vi.clearAllMocks(); silence()
        process.env.ADMIN_EMAIL = 'admin@example.com'
    })

    it('grants access to a listed admin', async () => {
        getUser.mockResolvedValue(asUser('admin@example.com'))
        await expect(authAdmin('u1')).resolves.toBe(true)
    })

    it('denies a non-admin', async () => {
        getUser.mockResolvedValue(asUser('shopper@example.com'))
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    it('tolerates spaces in a comma-separated list', async () => {
        process.env.ADMIN_EMAIL = 'a@x.com, b@x.com , c@x.com'
        for (const e of ['a@x.com', 'b@x.com', 'c@x.com']) {
            getUser.mockResolvedValue(asUser(e))
            await expect(authAdmin('u1')).resolves.toBe(true)
        }
    })

    it('matches case-insensitively in both directions', async () => {
        process.env.ADMIN_EMAIL = 'Admin@Example.COM'
        getUser.mockResolvedValue(asUser('aDMIN@example.com'))
        await expect(authAdmin('u1')).resolves.toBe(true)
    })

    it('fails closed when ADMIN_EMAIL is unset, empty or only separators', async () => {
        getUser.mockResolvedValue(asUser('admin@example.com'))
        for (const v of [undefined, '', ' , , ']) {
            if (v === undefined) delete process.env.ADMIN_EMAIL
            else process.env.ADMIN_EMAIL = v
            await expect(authAdmin('u1')).resolves.toBe(false)
        }
        expect(getUser).not.toHaveBeenCalled()
    })

    it('fails closed without a userId, and does not call Clerk', async () => {
        await expect(authAdmin(null)).resolves.toBe(false)
        await expect(authAdmin(undefined)).resolves.toBe(false)
        await expect(authAdmin('')).resolves.toBe(false)
        expect(getUser).not.toHaveBeenCalled()
    })

    it('fails closed when the user has no email address', async () => {
        getUser.mockResolvedValue({ emailAddresses: [] })
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    // F-12. Authorization used to read emailAddresses[0], which trusts array
    // order and accepts an address whose ownership Clerk never confirmed.
    it('refuses an unverified primary address', async () => {
        getUser.mockResolvedValue({
            primaryEmailAddressId: 'idn_1',
            emailAddresses: [
                { id: 'idn_1', emailAddress: 'admin@example.com', verification: { status: 'unverified' } },
            ],
        })
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    it('refuses an admin address the account merely claims but has not proven', async () => {
        // The takeover: ADMIN_EMAIL added to an attacker's own account, at
        // index 0, unverified. The old lookup granted the admin console.
        getUser.mockResolvedValue({
            primaryEmailAddressId: 'idn_own',
            emailAddresses: [
                { id: 'idn_claimed', emailAddress: 'admin@example.com', verification: { status: 'unverified' } },
                { id: 'idn_own', emailAddress: 'attacker@example.com', verification: { status: 'verified' } },
            ],
        })
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    it('grants access when the admin address is primary but not first in the array', async () => {
        // Position must not matter in either direction: a real admin whose
        // primary address happens to sit later must still be let in.
        getUser.mockResolvedValue({
            primaryEmailAddressId: 'idn_primary',
            emailAddresses: [
                { id: 'idn_old', emailAddress: 'old@example.com', verification: { status: 'verified' } },
                { id: 'idn_primary', emailAddress: 'admin@example.com', verification: { status: 'verified' } },
            ],
        })
        await expect(authAdmin('u1')).resolves.toBe(true)
    })

    it('refuses a verified admin address that is not the primary one', async () => {
        getUser.mockResolvedValue({
            primaryEmailAddressId: 'idn_own',
            emailAddresses: [
                { id: 'idn_secondary', emailAddress: 'admin@example.com', verification: { status: 'verified' } },
                { id: 'idn_own', emailAddress: 'someone@example.com', verification: { status: 'verified' } },
            ],
        })
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    it('fails closed on every malformed verification shape', async () => {
        const primary = (over) => ({
            primaryEmailAddressId: 'idn_1',
            emailAddresses: [{ id: 'idn_1', emailAddress: 'admin@example.com', ...over }],
        })
        for (const over of [
            {},                                         // no verification record
            { verification: null },
            { verification: {} },                       // no status
            { verification: { status: 'expired' } },
            { verification: { status: 'failed' } },
            { verification: { status: 'transferable' } },
            { verification: { status: 'VERIFIED' } },    // must be exact
        ]) {
            getUser.mockResolvedValue(primary(over))
            await expect(authAdmin('u1')).resolves.toBe(false)
        }
    })

    it('fails closed when no primary address is named', async () => {
        for (const user of [
            { emailAddresses: [{ id: 'idn_1', emailAddress: 'admin@example.com', verification: { status: 'verified' } }] },
            { primaryEmailAddressId: null, emailAddresses: [{ id: 'idn_1', emailAddress: 'admin@example.com', verification: { status: 'verified' } }] },
            { primaryEmailAddressId: 'idn_missing', emailAddresses: [{ id: 'idn_1', emailAddress: 'admin@example.com', verification: { status: 'verified' } }] },
            { primaryEmailAddressId: 'idn_1' },
        ]) {
            getUser.mockResolvedValue(user)
            await expect(authAdmin('u1')).resolves.toBe(false)
        }
    })

    it('fails closed when Clerk throws', async () => {
        getUser.mockRejectedValue(new Error('clerk unavailable'))
        await expect(authAdmin('u1')).resolves.toBe(false)
    })

    it('never resolves to a non-boolean', async () => {
        getUser.mockResolvedValue(asUser('admin@example.com'))
        expect(typeof await authAdmin('u1')).toBe('boolean')
        getUser.mockResolvedValue(asUser('nope@example.com'))
        expect(typeof await authAdmin('u1')).toBe('boolean')
    })
})

describe('authSeller', () => {
    beforeEach(() => { vi.clearAllMocks(); silence() })

    it('returns the store id for an approved, active store', async () => {
        prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status: 'approved', isActive: true } })
        await expect(authSeller('u1')).resolves.toBe('store_1')
    })

    // A store switched off is not trading, so its seller must not keep adding
    // products the storefront's own eligibility rule then hides.
    it('returns false for an approved store that has been deactivated', async () => {
        prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status: 'approved', isActive: false } })
        const r = await authSeller('u1')
        expect(r).toBe(false)
        expect(r).not.toBeUndefined()
    })

    it('returns false when isActive is absent rather than trusting the status alone', async () => {
        prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status: 'approved' } })
        await expect(authSeller('u1')).resolves.toBe(false)
    })

    // Prisma silently drops an `undefined` storeId from a `where` clause.
    for (const status of ['pending', 'rejected', 'suspended', '']) {
        it(`returns false (never undefined) for status "${status}"`, async () => {
            prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status, isActive: true } })
            const r = await authSeller('u1')
            expect(r).toBe(false)
            expect(r).not.toBeUndefined()
        })
    }

    it('returns false when the user owns no store', async () => {
        prisma.user.findUnique.mockResolvedValue({ store: null })
        await expect(authSeller('u1')).resolves.toBe(false)
    })

    it('returns false when the user row does not exist', async () => {
        prisma.user.findUnique.mockResolvedValue(null)
        await expect(authSeller('u1')).resolves.toBe(false)
    })

    it('returns false without querying when userId is missing', async () => {
        for (const v of [null, undefined, '']) await expect(authSeller(v)).resolves.toBe(false)
        expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('fails closed when the database throws', async () => {
        prisma.user.findUnique.mockRejectedValue(new Error('connection lost'))
        await expect(authSeller('u1')).resolves.toBe(false)
    })

    it('never resolves to undefined for any store shape', async () => {
        for (const v of [null, {}, { store: null }, { store: {} },
                         { store: { id: 's', status: 'pending' } },
                         { store: { id: 's', status: 'approved' } }]) {
            prisma.user.findUnique.mockResolvedValue(v)
            expect(await authSeller('u1')).not.toBeUndefined()
        }
    })
})

// The handler passed the body straight to prisma.coupon.create, so the caller
// chose every column, and a discount above 100 produced negative order totals.
describe('parseCouponInput', () => {
    const valid = {
        code: 'save10', description: '10% off', discount: 10,
        forNewUser: true, forMember: false, isPublic: true,
        expiresAt: '2030-01-01',
    }
    const parse = (over = {}) => parseCouponInput({ ...valid, ...over })

    it('normalises and returns exactly the real columns', () => {
        const { coupon, error } = parse()
        expect(error).toBeUndefined()
        expect(Object.keys(coupon).sort()).toEqual(
            ['code', 'description', 'discount', 'expiresAt', 'forMember', 'forNewUser', 'isPublic', 'maxRedemptions'])
        expect(coupon.code).toBe('SAVE10')
        expect(coupon.expiresAt).toBeInstanceOf(Date)
    })

    it('drops any column the caller invents, including createdAt', () => {
        // Mass assignment: `createdAt` belongs to the database, and a column
        // added to the model later must not become writable by accident.
        const { coupon } = parse({ createdAt: '1999-01-01', isAdmin: true, id: 'x' })
        expect(coupon.createdAt).toBeUndefined()
        expect(coupon.isAdmin).toBeUndefined()
        expect(coupon.id).toBeUndefined()
    })

    it('rejects a discount that would make an order negative', () => {
        for (const discount of [101, 500, 1e9, Infinity]) {
            expect(parse({ discount }).error).toMatch(/discount/)
        }
    })

    it('rejects a zero or negative discount', () => {
        for (const discount of [0, -1, -100]) {
            expect(parse({ discount }).error).toMatch(/discount/)
        }
    })

    it('accepts the boundary values', () => {
        expect(parse({ discount: 100 }).coupon.discount).toBe(100)
        expect(parse({ discount: 0.5 }).coupon.discount).toBe(0.5)
    })

    it('rejects a non-numeric discount rather than storing NaN', () => {
        for (const discount of ['abc', null, undefined, {}, NaN, '']) {
            expect(parse({ discount }).error).toMatch(/discount/)
        }
    })

    it('requires a usable code instead of crashing on a missing one', () => {
        // This is what used to throw: `coupon.code.toUpperCase()` on undefined.
        for (const code of [undefined, null, '', '   ', 42, {}]) {
            expect(parse({ code }).error).toMatch(/code/)
        }
        expect(parseCouponInput(undefined).error).toBe('missing coupon')
        expect(parseCouponInput(null).error).toBe('missing coupon')
        expect(parseCouponInput('SAVE10').error).toBe('missing coupon')
        expect(parseCouponInput([]).error).toBe('missing coupon')
    })

    it('requires a description and bounds both free-text fields', () => {
        expect(parse({ description: '' }).error).toMatch(/description/)
        expect(parse({ code: 'A'.repeat(33) }).error).toMatch(/too long/)
        expect(parse({ description: 'x'.repeat(201) }).error).toMatch(/too long/)
    })

    it('rejects an invalid or already-past expiry', () => {
        expect(parse({ expiresAt: 'not a date' }).error).toMatch(/expiry/)
        expect(parse({ expiresAt: undefined }).error).toMatch(/expiry/)
        expect(parse({ expiresAt: '2020-01-01' }).error).toMatch(/future/)
        // A coupon that expires the instant it is created is useless, not valid.
        const now = new Date('2026-06-01T00:00:00Z')
        expect(parseCouponInput({ ...valid, expiresAt: now }, { now }).error).toMatch(/future/)
    })

    it('coerces the flags to booleans rather than storing whatever was sent', () => {
        const { coupon } = parse({ forNewUser: 'yes', forMember: 0, isPublic: null })
        expect(coupon.forNewUser).toBe(true)
        expect(coupon.forMember).toBe(false)
        expect(coupon.isPublic).toBe(false)
    })

    it('treats an absent or blank redemption limit as unlimited', () => {
        expect(parse({ maxRedemptions: undefined }).coupon.maxRedemptions).toBeNull()
        expect(parse({ maxRedemptions: '' }).coupon.maxRedemptions).toBeNull()
        expect(parse({ maxRedemptions: null }).coupon.maxRedemptions).toBeNull()
    })

    it('accepts a whole-number redemption limit, including from a form string', () => {
        expect(parse({ maxRedemptions: 100 }).coupon.maxRedemptions).toBe(100)
        expect(parse({ maxRedemptions: '25' }).coupon.maxRedemptions).toBe(25)
    })

    it('rejects a redemption limit that is not a positive whole number', () => {
        for (const bad of [0, -1, 1.5, 'many', NaN, Infinity]) {
            expect(parse({ maxRedemptions: bad }).error).toMatch(/redemption limit/)
        }
    })

    it('accepts the exact shape the admin form sends', () => {
        // The form posts a Date object and a numeric discount.
        const { error } = parseCouponInput({
            code: 'NEW20', description: 'New users', discount: 20,
            forNewUser: true, forMember: false, isPublic: true,
            expiresAt: new Date('2030-06-01'),
        })
        expect(error).toBeUndefined()
    })
})

describe('cartSlice reducer', () => {
    const reduce = (state, action) => cart.default(state, action)
    const empty = { total: 0, cartItems: {} }

    it('adds a new item', () => {
        const s = reduce(empty, cart.addToCart({ productId: 'p1' }))
        expect(s).toEqual({ total: 1, cartItems: { p1: 1 } })
    })

    it('increments an existing item', () => {
        let s = reduce(empty, cart.addToCart({ productId: 'p1' }))
        s = reduce(s, cart.addToCart({ productId: 'p1' }))
        expect(s).toEqual({ total: 2, cartItems: { p1: 2 } })
    })

    it('decrements and drops the key at zero', () => {
        let s = reduce(empty, cart.addToCart({ productId: 'p1' }))
        s = reduce(s, cart.removeFromCart({ productId: 'p1' }))
        expect(s.cartItems).toEqual({})
        expect(s.total).toBe(0)
    })

    // total must never drift from the sum of cartItems.
    it('ignores removal of an item that is not in the cart', () => {
        const s = reduce(empty, cart.removeFromCart({ productId: 'ghost' }))
        expect(s.total).toBe(0)
        expect(s.cartItems).toEqual({})
    })

    it('never lets the total go negative through repeated removals', () => {
        let s = reduce(empty, cart.addToCart({ productId: 'p1' }))
        for (let i = 0; i < 10; i++) s = reduce(s, cart.removeFromCart({ productId: 'p1' }))
        expect(s.total).toBe(0)
        expect(s.total).toBeGreaterThanOrEqual(0)
    })

    it('keeps total consistent with the sum of quantities under random operations', () => {
        let s = empty
        const ids = ['p1', 'p2', 'p3', 'ghost']
        const ops = [cart.addToCart, cart.removeFromCart, cart.deleteItemFromCart]
        let seed = 7
        for (let i = 0; i < 300; i++) {
            seed = (seed * 1103515245 + 12345) % 2147483648
            const op = ops[seed % ops.length]
            const id = ids[(seed >> 5) % ids.length]
            s = reduce(s, op({ productId: id }))
        }
        const sum = Object.values(s.cartItems).reduce((a, b) => a + b, 0)
        expect(s.total).toBe(sum)
        expect(Object.values(s.cartItems).every(v => v > 0)).toBe(true)
    })

    it('deleteItemFromCart subtracts the whole quantity', () => {
        let s = empty
        for (let i = 0; i < 3; i++) s = reduce(s, cart.addToCart({ productId: 'p1' }))
        s = reduce(s, cart.addToCart({ productId: 'p2' }))
        s = reduce(s, cart.deleteItemFromCart({ productId: 'p1' }))
        expect(s).toEqual({ total: 1, cartItems: { p2: 1 } })
    })

    it('deleteItemFromCart is a no-op for an absent item', () => {
        const s = reduce({ total: 2, cartItems: { p1: 2 } }, cart.deleteItemFromCart({ productId: 'ghost' }))
        expect(s).toEqual({ total: 2, cartItems: { p1: 2 } })
    })

    it('hydrates from fetchCart and recomputes the total', () => {
        const s = reduce(empty, { type: cart.fetchCart.fulfilled.type, payload: { cart: { p1: 2, p2: 3 } } })
        expect(s.total).toBe(5)
        expect(s.cartItems).toEqual({ p1: 2, p2: 3 })
    })

    it('survives an empty or missing fetchCart payload', () => {
        for (const payload of [{ cart: {} }, {}, undefined]) {
            const s = reduce(empty, { type: cart.fetchCart.fulfilled.type, payload })
            expect(s).toEqual({ total: 0, cartItems: {}, status: 'loaded' })
        }
    })

    it('no longer exports the unused clearCart action', () => {
        expect(cart.clearCart).toBeUndefined()
    })
})

describe('cartSlice uploadCart thunk', () => {
    beforeEach(() => { vi.clearAllMocks(); silence(); vi.useFakeTimers() })
    afterEach(() => vi.useRealTimers())

    // The cart must be loaded before anything may be written back; see the
    // "cold start" tests below for why.
    const loaded = (store, items = {}) => store.dispatch({
        type: cart.fetchCart.fulfilled.type, payload: { cart: items },
    })

    it('debounces rapid dispatches into a single POST', async () => {
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })
        const getToken = async () => 'tok'

        loaded(store)
        store.dispatch(cart.addToCart({ productId: 'p1' }))
        for (let i = 0; i < 5; i++) store.dispatch(cart.uploadCart({ getToken }))

        expect(axiosPost).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).toHaveBeenCalledTimes(1)
    })

    // The request used to run inside a setTimeout callback, settling after the
    // thunk had returned, so nothing could observe it failing.
    it('rejects the thunk when the write fails, instead of reporting success', async () => {
        const store = makeStore()
        axiosPost.mockRejectedValue({ response: { status: 401, data: { error: 'not authorized' } } })

        loaded(store, { p1: 1 })
        const dispatched = store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        const action = await dispatched

        expect(action.type).toBe(cart.uploadCart.rejected.type)
        expect(action.payload).toEqual({ error: 'not authorized' })
    })

    it('records the failure in state so a stalled sync is detectable', async () => {
        const store = makeStore()
        axiosPost.mockRejectedValue({ response: { status: 401, data: { error: 'not authorized' } } })

        loaded(store, { p1: 1 })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)

        expect(store.getState().cart.syncError).toBe('not authorized')
    })

    it('clears the recorded failure once a write succeeds again', async () => {
        const store = makeStore()
        loaded(store, { p1: 1 })

        axiosPost.mockRejectedValue({ response: { status: 400, data: { error: 'offline' } } })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        expect(store.getState().cart.syncError).toBe('offline')

        axiosPost.mockResolvedValue({ data: {} })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        expect(store.getState().cart.syncError).toBeNull()
    })

    it('surfaces a network error with no response body', async () => {
        const store = makeStore()
        axiosPost.mockRejectedValue(new Error('Network Error'))

        loaded(store, { p1: 1 })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        await vi.advanceTimersByTimeAsync(2100)      // and the retry

        expect(store.getState().cart.syncError).toBe('Network Error')
    })

    it('retries once when the failure looks transient', async () => {
        // A cold start or a dropped connection should not cost the shopper their
        // basket for the sake of one unlucky request.
        const store = makeStore()
        axiosPost
            .mockRejectedValueOnce(new Error('Network Error'))
            .mockResolvedValueOnce({ data: {} })

        loaded(store, { p1: 1 })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        await vi.advanceTimersByTimeAsync(2100)

        expect(axiosPost).toHaveBeenCalledTimes(2)
        expect(store.getState().cart.syncError).toBeNull()
    })

    it('does not retry a refusal', async () => {
        // Retrying a 4xx just fails again, more slowly.
        const store = makeStore()
        axiosPost.mockRejectedValue({ response: { status: 400, data: { error: 'cart must be an object' } } })

        loaded(store, { p1: 1 })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)

        expect(axiosPost).toHaveBeenCalledTimes(1)
        expect(store.getState().cart.syncError).toBe('cart must be an object')
    })

    it('reports a getToken failure rather than swallowing it', async () => {
        const store = makeStore()
        loaded(store, { p1: 1 })
        store.dispatch(cart.uploadCart({ getToken: async () => { throw new Error('session expired') } }))
        await vi.advanceTimersByTimeAsync(1100)

        expect(store.getState().cart.syncError).toBe('session expired')
        expect(axiosPost).not.toHaveBeenCalled()
    })

    it('settles every superseded dispatch instead of leaving it pending', async () => {
        // Each dispatch returns a promise. Cancelling a debounce by clearTimeout
        // alone would leave the earlier ones unresolved forever.
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })
        loaded(store, { p1: 1 })

        const dispatched = [1, 2, 3].map(() => store.dispatch(cart.uploadCart({ getToken: async () => 'tok' })))
        await vi.advanceTimersByTimeAsync(1100)

        const results = await Promise.all(dispatched)
        expect(results).toHaveLength(3)
        expect(results.filter(a => a.payload?.skipped === 'superseded')).toHaveLength(2)
        expect(results.filter(a => a.payload?.saved)).toHaveLength(1)
        expect(axiosPost).toHaveBeenCalledTimes(1)
    })

    it('does not record an error when an upload is skipped rather than failed', async () => {
        // A skip is not a failure and must not look like one.
        const store = makeStore()
        store.dispatch({ type: cart.fetchCart.pending.type })
        const dispatched = store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        const action = await dispatched

        expect(action.type).toBe(cart.uploadCart.fulfilled.type)
        expect(action.payload).toEqual({ skipped: 'not-loaded' })
        expect(store.getState().cart.syncError).toBeNull()
    })

    // The layout dispatches fetchCart and uploadCart together on mount, so on a
    // cold start the upload used to persist the empty initial state.
    it('does not write anything back before the cart has been fetched', async () => {
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })

        store.dispatch({ type: cart.fetchCart.pending.type })   // still in flight
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))

        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).not.toHaveBeenCalled()
    })

    it('writes the fetched cart, not the empty state, when the fetch is slow', async () => {
        // The exact cold-start sequence: upload scheduled at t=0, cart arrives
        // after the debounce would have fired.
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })

        store.dispatch({ type: cart.fetchCart.pending.type })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).not.toHaveBeenCalled()          // nothing wiped

        loaded(store, { saved: 3 })                        // slow fetch lands
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost.mock.calls[0][1]).toEqual({ cart: { saved: 3 } })
    })

    it('still writes an upload queued during loading once the cart arrives in time', async () => {
        // Evaluated when the timer fires, not when scheduled: checking at
        // schedule time would drop this upload rather than defer it.
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })

        store.dispatch({ type: cart.fetchCart.pending.type })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))

        await vi.advanceTimersByTimeAsync(400)
        loaded(store, { saved: 2 })                        // lands inside the window
        await vi.advanceTimersByTimeAsync(700)

        expect(axiosPost).toHaveBeenCalledTimes(1)
        expect(axiosPost.mock.calls[0][1]).toEqual({ cart: { saved: 2 } })
    })

    it('stays blocked when the fetch fails, rather than guessing the cart is empty', async () => {
        // A failed read means the saved cart is unknown. Writing local state
        // over it would lose a basket the shopper still has.
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })

        store.dispatch({ type: cart.fetchCart.rejected.type })
        store.dispatch(cart.addToCart({ productId: 'p1' }))
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))

        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).not.toHaveBeenCalled()
        expect(store.getState().cart.status).toBe('failed')
    })

    it('tracks the load status across the fetch lifecycle', () => {
        const store = makeStore()
        expect(store.getState().cart.status).toBe('idle')
        store.dispatch({ type: cart.fetchCart.pending.type })
        expect(store.getState().cart.status).toBe('loading')
        loaded(store, { p1: 1 })
        expect(store.getState().cart.status).toBe('loaded')
    })

    it('distinguishes a genuinely empty cart from one not yet loaded', async () => {
        // Both have cartItems {}. Only the loaded one may be written back.
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })

        loaded(store, {})                                  // genuinely empty
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).toHaveBeenCalledTimes(1)
        expect(axiosPost.mock.calls[0][1]).toEqual({ cart: {} })
    })

    it('posts the latest cart state, not the state at dispatch time', async () => {
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })
        loaded(store)
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        store.dispatch(cart.addToCart({ productId: 'late' }))

        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost.mock.calls[0][1]).toEqual({ cart: { late: 1 } })
    })
})

describe('productSlice reducer', () => {
    it('starts empty and hydrates from fetchProducts', () => {
        const initial = product.default(undefined, { type: '@@INIT' })
        expect(initial).toEqual({ list: [], byId: {}, nextCursor: null, status: 'idle' })
        const s = product.default(initial, {
            type: product.fetchProducts.fulfilled.type,
            payload: { products: [{ id: 'p1' }], nextCursor: null },
        })
        expect(s.list).toHaveLength(1)
        expect(s.status).toBe('loaded')
    })

    // The catalogue arrives a page at a time; the cart resolves its items out of
    // what the client holds, so paginating without an id index empties baskets.
    it('replaces the page on a fresh fetch and extends it on a cursor fetch', () => {
        let s = product.default(undefined, { type: '@@INIT' })
        s = product.default(s, {
            type: product.fetchProducts.fulfilled.type,
            payload: { products: [{ id: 'p1' }], nextCursor: 'p1' },
        })
        s = product.default(s, {
            type: product.fetchProducts.fulfilled.type,
            payload: { products: [{ id: 'p2' }], nextCursor: null, append: true },
        })
        expect(s.list.map(p => p.id)).toEqual(['p1', 'p2'])
        expect(s.nextCursor).toBeNull()

        // A new search starts over rather than appending to the old results.
        s = product.default(s, {
            type: product.fetchProducts.fulfilled.type,
            payload: { products: [{ id: 'p9' }], nextCursor: null },
        })
        expect(s.list.map(p => p.id)).toEqual(['p9'])
    })

    it('remembers every product it has seen, page or not', () => {
        let s = product.default(undefined, { type: '@@INIT' })
        s = product.default(s, {
            type: product.fetchProducts.fulfilled.type,
            payload: { products: [{ id: 'p1' }], nextCursor: null },
        })
        s = product.default(s, {
            type: product.fetchProductsByIds.fulfilled.type,
            payload: { products: [{ id: 'off_page' }] },
        })
        // Indexed for the cart to price, but not shown as part of the page.
        expect(Object.keys(s.byId).sort()).toEqual(['off_page', 'p1'])
        expect(s.list.map(p => p.id)).toEqual(['p1'])
    })

    it('coerces a missing payload to an empty list rather than undefined', () => {
        const s = product.default(
            { list: [], byId: {}, nextCursor: null, status: 'idle' },
            { type: product.fetchProducts.fulfilled.type, payload: undefined })
        expect(s.list).toEqual([])
    })

    it('no longer exports the unused setProduct/clearProduct actions', () => {
        expect(product.setProduct).toBeUndefined()
        expect(product.clearProduct).toBeUndefined()
    })
})

describe('addressSlice reducer', () => {
    it('appends an address without mutating the previous state', () => {
        const initial = addressSlice.default(undefined, { type: '@@INIT' })
        const s = addressSlice.default(initial, addressSlice.addAddress({ id: 'a1' }))
        expect(s.list).toEqual([{ id: 'a1' }])
        expect(initial.list).toEqual([])
    })

    it('replaces the list on fetchAddress', () => {
        const s = addressSlice.default({ list: [{ id: 'old' }] },
            { type: addressSlice.fetchAddress.fulfilled.type, payload: [{ id: 'a1' }] })
        expect(s.list).toEqual([{ id: 'a1' }])
    })
})

describe('ratingSlice reducer', () => {
    it('appends a rating', () => {
        const initial = ratingSlice.default(undefined, { type: '@@INIT' })
        const s = ratingSlice.default(initial, ratingSlice.addRating({ id: 'r1' }))
        expect(s.ratings).toEqual([{ id: 'r1' }])
    })

    it('replaces ratings on fetchUserRatings', () => {
        const s = ratingSlice.default({ ratings: [{ id: 'old' }] },
            { type: ratingSlice.fetchUserRatings.fulfilled.type, payload: [{ id: 'r1' }] })
        expect(s.ratings).toEqual([{ id: 'r1' }])
    })
})

describe('thunk error handling', () => {
    beforeEach(() => { vi.clearAllMocks(); silence() })

    it('survives a network error with no response object', async () => {
        axiosGet.mockRejectedValue(new Error('Network Error'))
        const store = makeStore()
        const r = await store.dispatch(product.fetchProducts())
        expect(r.type).toBe(product.fetchProducts.rejected.type)
        expect(r.payload).toEqual({ error: 'Network Error' })
    })

    it('passes through a server error body when present', async () => {
        axiosGet.mockRejectedValue({ response: { data: { error: 'boom' } } })
        const store = makeStore()
        const r = await store.dispatch(product.fetchProducts())
        expect(r.payload).toEqual({ error: 'boom' })
    })
})

describe('makeStore', () => {
    it('registers exactly the four feature reducers', () => {
        expect(Object.keys(makeStore().getState()).sort())
            .toEqual(['address', 'cart', 'product', 'rating'])
    })

    it('produces an isolated store per call, so SSR requests cannot share state', () => {
        const a = makeStore(), b = makeStore()
        a.dispatch(cart.addToCart({ productId: 'p1' }))
        expect(a.getState().cart.total).toBe(1)
        expect(b.getState().cart.total).toBe(0)
    })

    it('exposes the documented initial state', () => {
        expect(makeStore().getState()).toEqual({
            cart: { total: 0, cartItems: {}, status: 'idle', syncError: null },
            product: { list: [], byId: {}, nextCursor: null, status: 'idle' },
            address: { list: [] },
            rating: { ratings: [] },
        })
    })
})

describe('assets module', () => {
    it('exports only images that are actually referenced by components', () => {
        expect(Object.keys(assets).sort())
            .toEqual(['hero_model_img', 'hero_product_img1', 'hero_product_img2', 'upload_area'])
    })

    it('exports the marquee categories and the specs list', () => {
        expect(categories.length).toBeGreaterThan(0)
        expect(ourSpecsData).toHaveLength(3)
        for (const s of ourSpecsData) {
            expect(s.title).toBeTruthy()
            expect(s.description).toBeTruthy()
            expect(s.icon).toBeTruthy()
            // OurSpec.jsx appends an alpha suffix, so this must be 6-digit hex.
            expect(s.accent).toMatch(/^#[0-9A-Fa-f]{6}$/)
        }
    })

    it('no longer exports any demo fixture data', () => {
        for (const k of ['productDummyData', 'dummyRatingsData', 'storesDummyData',
                         'orderDummyData', 'couponDummyData', 'dummyUserData',
                         'dummyStoreData', 'addressDummyData',
                         'dummyAdminDashboardData', 'dummyStoreDashboardData']) {
            expect(assets[k]).toBeUndefined()
        }
    })
})

// F-27. Nothing limited how often, or how expensively, a caller could use the
// endpoints that cost real money.
describe('rateLimit', () => {
    beforeEach(() => __resetRateLimits())

    it('allows requests up to the limit and refuses the next', () => {
        for (let i = 0; i < 3; i++) {
            expect(rateLimit({ key: 'k', limit: 3, windowMs: 1000 }).allowed).toBe(true)
        }
        expect(rateLimit({ key: 'k', limit: 3, windowMs: 1000 }).allowed).toBe(false)
    })

    it('counts each caller separately', () => {
        rateLimit({ key: 'a', limit: 1, windowMs: 1000 })
        expect(rateLimit({ key: 'a', limit: 1, windowMs: 1000 }).allowed).toBe(false)
        // One caller exhausting their budget must not lock anyone else out.
        expect(rateLimit({ key: 'b', limit: 1, windowMs: 1000 }).allowed).toBe(true)
    })

    it('lets the budget recover as the window slides', () => {
        const now = 1_000_000
        rateLimit({ key: 'k', limit: 1, windowMs: 1000, now })
        expect(rateLimit({ key: 'k', limit: 1, windowMs: 1000, now: now + 999 }).allowed).toBe(false)
        // Immediately after the boundary the previous window still counts in
        // full -- that is what stops a burst straddling it.
        expect(rateLimit({ key: 'k', limit: 1, windowMs: 1000, now: now + 1000 }).allowed).toBe(false)
        // Once it has decayed, the caller is served again.
        expect(rateLimit({ key: 'k', limit: 1, windowMs: 1000, now: now + 2000 }).allowed).toBe(true)
    })

    it('does not let a caller spend twice the budget across a boundary', () => {
        // The reason for a sliding window: with a fixed one, 10 requests just
        // before the boundary and 10 just after are both permitted.
        const windowMs = 60_000
        const start = Math.floor(2_000_000 / windowMs) * windowMs
        let allowed = 0

        for (let i = 0; i < 10; i++) {
            if (rateLimit({ key: 'burst', limit: 10, windowMs, now: start + windowMs - 1 }).allowed) allowed++
        }
        for (let i = 0; i < 10; i++) {
            if (rateLimit({ key: 'burst', limit: 10, windowMs, now: start + windowMs + 1 }).allowed) allowed++
        }

        // A fixed window would allow all 20. The sliding estimate lets at most
        // one extra through at the instant of the boundary.
        expect(allowed).toBeLessThanOrEqual(11)
        expect(allowed).toBeGreaterThanOrEqual(10)
    })

    it('reports how long to wait, never zero while blocked', () => {
        const now = 1_000_000
        rateLimit({ key: 'k', limit: 1, windowMs: 5000, now })
        const blocked = rateLimit({ key: 'k', limit: 1, windowMs: 5000, now: now + 4999 })
        expect(blocked.allowed).toBe(false)
        expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    })

    it('reports the remaining budget', () => {
        expect(rateLimit({ key: 'k', limit: 3, windowMs: 1000 }).remaining).toBe(2)
        expect(rateLimit({ key: 'k', limit: 3, windowMs: 1000 }).remaining).toBe(1)
    })

    it('does not grow without bound', () => {
        // Counters are held in memory; a distinct key per request must not leak.
        const now = 1_000_000
        for (let i = 0; i < 6000; i++) {
            rateLimit({ key: `k${i}`, limit: 1, windowMs: 1000, now })
        }
        // A later window prunes what has expired.
        rateLimit({ key: 'trigger', limit: 1, windowMs: 1000, now: now + 10_000 })
        expect(rateLimit({ key: 'k0', limit: 1, windowMs: 1000, now: now + 10_000 }).allowed).toBe(true)
    })
})

describe('upload limits', () => {
    it('allows only image types the storefront can display', () => {
        for (const ok of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
            expect(isAllowedImageType(ok)).toBe(true)
        }
        for (const bad of ['application/pdf', 'text/html', 'image/svg+xml', '', null, undefined, 42]) {
            expect(isAllowedImageType(bad)).toBe(false)
        }
    })

    it('estimates base64 size without decoding it', () => {
        // Decoding to measure would allocate the very memory the cap prevents.
        expect(base64Bytes('AAAA')).toBe(3)
        expect(base64Bytes('A'.repeat(4000))).toBe(3000)
        expect(base64Bytes(null)).toBe(0)
        expect(base64Bytes(undefined)).toBe(0)
    })

    it('reads the format from the bytes, not the label', () => {
        expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
        expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
        expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif')
        expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe('image/webp')
        expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull()   // PDF
        expect(sniffImageType(new Uint8Array([1, 2]))).toBeNull()
        expect(sniffImageType(null)).toBeNull()
    })

    it('refuses a file whose bytes contradict its claimed type', () => {
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        expect(bytesMatchClaimedType(pngBytes, 'image/png')).toBe(true)
        // A PDF renamed and relabelled as a PNG.
        expect(bytesMatchClaimedType(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'image/png')).toBe(false)
        // A real PNG claiming to be something else.
        expect(bytesMatchClaimedType(pngBytes, 'image/jpeg')).toBe(false)
        expect(bytesMatchClaimedType(pngBytes, undefined)).toBe(false)
    })

    it('sets ceilings a real upload stays under', () => {
        expect(MAX_IMAGE_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
        expect(MAX_IMAGES_PER_PRODUCT).toBeGreaterThan(1)
    })
})

// Migrations ran inside the build, landing while the previous version served
// traffic. Separating them is only safe if every migration is additive.
describe('migrations are safe to apply before deploying', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const migrationsDir = resolve(root, 'prisma/migrations')

    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(name => ({
            name: name.name,
            sql: readFileSync(resolve(migrationsDir, name.name, 'migration.sql'), 'utf8'),
        }))

    // Statements that break a running previous version. An `-- expand-contract:`
    // note opts a migration out, for the second phase of a planned change.
    const DESTRUCTIVE = [
        [/DROP\s+TABLE/i, 'DROP TABLE'],
        [/DROP\s+COLUMN/i, 'DROP COLUMN'],
        [/RENAME\s+(TO|COLUMN)/i, 'RENAME'],
        [/ALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL/i, 'SET NOT NULL'],
        [/ALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE/i, 'ALTER COLUMN TYPE'],
    ]

    it('found the migrations to check', () => {
        // A wrong path would leave every assertion below vacuously true.
        expect(migrations.length).toBeGreaterThan(0)
        expect(migrations.every(m => m.sql.length > 0)).toBe(true)
    })

    it('contains nothing that would break the running version', () => {
        const offences = []
        for (const { name, sql } of migrations) {
            if (/--\s*expand-contract:/i.test(sql)) continue
            for (const [pattern, label] of DESTRUCTIVE) {
                if (pattern.test(sql)) offences.push(`${name}: ${label}`)
            }
        }
        expect(offences).toEqual([])
    })

    it('adds columns as nullable or with a default', () => {
        // A NOT NULL column with no default fails outright on a non-empty table,
        // and would also reject inserts from the previous version.
        const offences = []
        for (const { name, sql } of migrations) {
            for (const [, statement] of sql.matchAll(/ADD\s+COLUMN\s+([^;]+);/gi)) {
                if (/NOT\s+NULL/i.test(statement) && !/DEFAULT/i.test(statement)) {
                    offences.push(`${name}: ${statement.trim().slice(0, 60)}`)
                }
            }
        }
        expect(offences).toEqual([])
    })
})

// A deploy can now ship code whose schema is not there. Nothing forces the
// migration to run, but this refuses to let one reach `main` without it.
describe('the schema and the migrations agree', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')
    const migrationsDir = resolve(root, 'prisma/migrations')
    const sql = readdirSync(migrationsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => readFileSync(resolve(migrationsDir, e.name, 'migration.sql'), 'utf8'))
        .join('\n')

    // Every model and every column. A field typed as another model is a
    // relation: it describes a join, not a column.
    const modelNames = [...schema.matchAll(/^model (\w+) \{/gm)].map(([, n]) => n)

    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
        name,
        fields: body
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('//') && !line.startsWith('@@'))
            .map(line => line.split(/\s+/))
            .filter(parts => parts.length >= 2)
            .filter(([, type]) => !modelNames.includes(type.replace(/[[\]?]/g, '')))
            .map(([field]) => field),
    }))

    it('parsed the schema it is checking', () => {
        expect(models.length).toBeGreaterThanOrEqual(8)
        expect(models.find(m => m.name === 'Order').fields).toContain('couponCode')
    })

    it('has a migration creating every model', () => {
        const missing = models
            .filter(m => !sql.includes(`CREATE TABLE "public"."${m.name}"`))
            .map(m => m.name)
        expect(missing).toEqual([])
    })

    it('has a migration for every column the schema declares', () => {
        // Catches a field added to the schema with no migration, so the column
        // exists everywhere except the database.
        const missing = []
        for (const model of models) {
            for (const field of model.fields) {
                const created = new RegExp(`CREATE TABLE "public"\\."${model.name}"[\\s\\S]*?"${field}"[\\s\\S]*?\\n\\);`)
                const added = new RegExp(`ALTER TABLE "public"\\."${model.name}" ADD COLUMN\\s+"${field}"`)
                if (!created.test(sql) && !added.test(sql)) missing.push(`${model.name}.${field}`)
            }
        }
        expect(missing).toEqual([])
    })
})

describe('the build does not change the database', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

    it('keeps migration out of the build script', () => {
        // Running it here applied schema changes while the previous version was
        // still live, and made two concurrent builds race for the same lock.
        expect(pkg.scripts.build).not.toMatch(/migrate/)
    })

    it('still generates the client during the build', () => {
        expect(pkg.scripts.build).toMatch(/prisma generate/)
    })

    it('exposes migration as its own deliberate step', () => {
        expect(pkg.scripts['migrate:deploy']).toBe('prisma migrate deploy')
        expect(pkg.scripts['migrate:status']).toBe('prisma migrate status')
    })
})

// `.nvmrc` said 22, the deployment picked Vercel's default, and a developer's
// machine was unconstrained: three answers, with nothing comparing them.
describe('the supported Node version is declared once', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const read = (file) => readFileSync(resolve(root, file), 'utf8')

    const nvmrc = read('.nvmrc').trim()
    const engines = JSON.parse(read('package.json')).engines
    const npmrc = read('.npmrc')
    const ci = read('.github/workflows/ci.yml')

    it('declares a Node range at all', () => {
        // Vercel reads this to choose the build runtime. Without it the
        // deployment silently gets whatever the platform defaults to.
        expect(engines?.node).toBeTruthy()
    })

    it('agrees with .nvmrc on the major version', () => {
        const major = nvmrc.replace(/^v/, '').split('.')[0]
        expect(engines.node.startsWith(major)).toBe(true)
    })

    it('makes the range a rule rather than advice', () => {
        // npm prints EBADENGINE and installs anyway unless this is set, which is
        // how the drift went unnoticed while every command appeared to succeed.
        expect(npmrc).toMatch(/^\s*engine-strict\s*=\s*true\s*$/m)
    })

    it('has CI follow .nvmrc rather than its own hardcoded version', () => {
        expect(ci).toMatch(/node-version-file:\s*\.nvmrc/)
        expect(ci).not.toMatch(/node-version:\s*['"]?\d/)
    })
})

// F-24. Only `.env` was ignored, so `.env.local` -- which is Next.js's own
// convention -- and every other variant were committable.
describe('environment files are not committable', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))

    // Asked of git, since pattern order and negations make the effective rule
    // non-obvious. `--no-index` is load-bearing: without it git reports any
    // *tracked* file as not-ignored, making the `.env.example` case vacuous.
    const isIgnored = (path) => {
        const { status } = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: root })
        return status === 0
    }

    it('can ask git the question at all', () => {
        // Without this, a git that failed to run would make every assertion
        // below report "not ignored" and the suite would still be green.
        const { status } = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })
        expect(status).toBe(0)
    })

    it('ignores every env file that could hold a live credential', () => {
        for (const file of [
            '.env',
            '.env.local',                  // the Next.js convention
            '.env.production',
            '.env.production.local',
            '.env.development.local',
            '.env.test.local',
        ]) {
            expect(isIgnored(file), `${file} is committable`).toBe(true)
        }
    })

    it('keeps the checked-in template visible', () => {
        // `.env*` would swallow it; the negation must survive.
        expect(isIgnored('.env.example')).toBe(false)
    })

    it('still tracks the template', () => {
        const { status } = spawnSync('git', ['ls-files', '--error-unmatch', '.env.example'], { cwd: root })
        expect(status).toBe(0)
    })
})

// F-21. Any string the enum happened to accept was written as an order status,
// in any order, so an order could be marked DELIVERED and then moved back.
describe('parseOrderStatus', () => {
    it('covers exactly the statuses the schema defines', () => {
        // If a stage is added to the enum and not to the sequence, its rank is
        // -1 and it becomes unreachable. Better to fail here than in production.
        expect([...ORDER_STATUS_SEQUENCE].sort()).toEqual(Object.values(OrderStatus).sort())
    })

    it('accepts each real status', () => {
        for (const status of ORDER_STATUS_SEQUENCE) {
            expect(parseOrderStatus(status).status).toBe(status)
        }
    })

    it('rejects anything that is not a status', () => {
        for (const bad of ['delivered', 'CANCELLED', '', 'DROP TABLE', undefined, null, 42, {}, ['SHIPPED']]) {
            expect(parseOrderStatus(bad).error).toBe('invalid order status')
        }
    })

    it('allows a status to be reached from any earlier one', () => {
        expect(parseOrderStatus('DELIVERED').reachableFrom)
            .toEqual(['ORDER_PLACED', 'PROCESSING', 'SHIPPED', 'DELIVERED'])
        expect(parseOrderStatus('PROCESSING').reachableFrom)
            .toEqual(['ORDER_PLACED', 'PROCESSING'])
    })

    it('never lets a later status reach an earlier one', () => {
        // The property, stated directly: nothing may move backwards.
        for (const [i, target] of ORDER_STATUS_SEQUENCE.entries()) {
            const { reachableFrom } = parseOrderStatus(target)
            for (const [j, from] of ORDER_STATUS_SEQUENCE.entries()) {
                expect(reachableFrom.includes(from)).toBe(j <= i)
            }
        }
    })

    it('treats re-sending the current status as reachable', () => {
        // A double-clicked dropdown should not be an error.
        for (const status of ORDER_STATUS_SEQUENCE) {
            expect(parseOrderStatus(status).reachableFrom).toContain(status)
        }
    })

    it('permits skipping ahead', () => {
        // A seller who packs and ships at once should not have to click through.
        expect(parseOrderStatus('SHIPPED').reachableFrom).toContain('ORDER_PLACED')
    })
})

// F-20. The parsed request body was written straight into the `cart` JSONB
// column, so any signed-in user could store arbitrary JSON of any size.
describe('parseCartInput', () => {
    it('accepts a cart the client actually sends', () => {
        const { cart, error } = parseCartInput({ p1: 2, p2: 1 })
        expect(error).toBeUndefined()
        expect(cart).toEqual({ p1: 2, p2: 1 })
    })

    it('accepts an empty cart', () => {
        expect(parseCartInput({}).cart).toEqual({})
    })

    it('rejects anything that is not a plain object', () => {
        for (const bad of [null, undefined, 'cart', 42, [], [['p1', 1]], true]) {
            expect(parseCartInput(bad).error).toBe('cart must be an object')
        }
    })

    it('rejects the arbitrary JSON the audit stored', () => {
        // The probe wrote a 1KB string and a nested object under invented keys.
        expect(parseCartInput({ a: 'A'.repeat(1000) }).error).toMatch(/whole numbers/)
        expect(parseCartInput({ nested: { deep: [1, 2, 3] } }).error).toMatch(/whole numbers/)
    })

    it('rejects quantities that are not positive whole numbers', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, '2', null, undefined, {}]) {
            expect(parseCartInput({ p1: bad }).error).toBeDefined()
        }
    })

    it('caps the number of distinct products', () => {
        const huge = Object.fromEntries(
            Array.from({ length: MAX_CART_ITEMS + 1 }, (_, i) => [`p${i}`, 1]))
        expect(parseCartInput(huge).error).toMatch(/more than/)

        const atLimit = Object.fromEntries(
            Array.from({ length: MAX_CART_ITEMS }, (_, i) => [`p${i}`, 1]))
        expect(parseCartInput(atLimit).error).toBeUndefined()
    })

    it('caps the quantity per line', () => {
        expect(parseCartInput({ p1: MAX_QUANTITY }).error).toBeUndefined()
        expect(parseCartInput({ p1: MAX_QUANTITY + 1 }).error).toMatch(/between 1 and/)
    })

    it('caps the length of a product id', () => {
        expect(parseCartInput({ ['x'.repeat(65)]: 1 }).error).toMatch(/invalid product id/)
        expect(parseCartInput({ '': 1 }).error).toMatch(/invalid product id/)
    })

    it('returns a fresh object rather than the untrusted one', () => {
        // What gets persisted must not be the untrusted object itself.
        const input = { p1: 1 }
        expect(parseCartInput(input).cart).not.toBe(input)
    })
})

// F-18. Money was multiplied, discounted and summed in binary floating point,
// and each per-store total was rounded independently before being added up.
describe('money arithmetic', () => {
    it('recovers exact cents from a stored price', () => {
        // The columns are Float. That is safe for storage -- what matters is
        // that a stored two-decimal value round-trips to the intended cent.
        for (const [price, cents] of [[29.99, 2999], [0.1, 10], [0.07, 7], [1234.56, 123456], [0, 0]]) {
            expect(toCents(price)).toBe(cents)
        }
    })

    it('does not drift when summing', () => {
        // 0.1 + 0.2 is 0.30000000000000004 in floating point.
        expect(sumCents([toCents(0.1), toCents(0.2)])).toBe(30)
        expect(fromCents(sumCents([toCents(0.1), toCents(0.2)]))).toBe(0.3)
    })

    it('survives a long accumulation exactly', () => {
        const cents = sumCents(Array.from({ length: 1000 }, () => toCents(0.07)))
        expect(cents).toBe(7000)
        expect(fromCents(cents)).toBe(70)
    })

    it('rounds a percentage once, at the point it is applied', () => {
        expect(percentOfCents(1000, 10)).toBe(100)
        expect(percentOfCents(999, 10)).toBe(100)     // 99.9 -> 100
        expect(percentOfCents(1005, 50)).toBe(503)    // 502.5 -> 503
        expect(percentOfCents(0, 50)).toBe(0)
    })

    it('never yields a non-finite amount from malformed input', () => {
        for (const bad of [undefined, null, NaN, 'abc', Infinity]) {
            expect(Number.isFinite(toCents(bad))).toBe(true)
            expect(Number.isFinite(percentOfCents(1000, bad))).toBe(true)
        }
    })
})

describe('basket pricing', () => {
    const item = (price, quantity = 1, storeId = 's1') => ({ id: `p${price}`, price, quantity, storeId })

    it('charges shipping once across a multi-seller basket', () => {
        const { totalCents } = priceBasket({
            items: [item(10, 1, 's1'), item(20, 1, 's2'), item(30, 1, 's3')],
            chargeShipping: true,
        })
        expect(totalCents).toBe(6000 + SHIPPING_CENTS)
    })

    it('omits shipping for a member', () => {
        const { totalCents } = priceBasket({ items: [item(10)], chargeShipping: false })
        expect(totalCents).toBe(1000)
    })

    it('splits the basket per seller', () => {
        const { stores } = priceBasket({ items: [item(10, 2, 's1'), item(5, 1, 's2')], chargeShipping: false })
        expect(stores.map(s => [s.storeId, s.cents])).toEqual([['s1', 2000], ['s2', 500]])
    })

    it('never prices below zero, whatever the stored coupon says', () => {
        const { totalCents } = priceBasket({ items: [item(10)], discountPercent: 500, chargeShipping: false })
        expect(totalCents).toBe(0)
    })

    // The defect this finding describes: per-store rounding summed to a
    // different figure than the basket rounded once.
    it('totals a basket to the sum of its per-seller parts, exactly', () => {
        const items = [item(10.005, 1, 's1'), item(10.005, 1, 's2')]
        const { stores, totalCents } = priceBasket({ items, discountPercent: 0, chargeShipping: false })
        expect(totalCents).toBe(stores.reduce((a, s) => a + s.cents, 0))
    })

    it('agrees with itself across any randomised basket', () => {
        // The basket total is always exactly the sum of its parts -- the
        // invariant the old float arithmetic could not hold.
        let seed = 7
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

        for (let run = 0; run < 300; run++) {
            const items = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
                id: `p${rand()}`,
                price: Math.round(rand() * 100000) / 100,        // any 2dp price up to 1000
                quantity: 1 + Math.floor(rand() * 5),
                storeId: `s${Math.floor(rand() * 3)}`,
            }))
            const discountPercent = Math.floor(rand() * 101)
            const chargeShipping = rand() > 0.5

            const { stores, totalCents } = priceBasket({ items, discountPercent, chargeShipping })

            expect(totalCents).toBe(stores.reduce((a, s) => a + s.cents, 0))
            expect(Number.isInteger(totalCents)).toBe(true)
            expect(totalCents).toBeGreaterThanOrEqual(0)
            // And the persisted currency value round-trips back to the same cents.
            for (const store of stores) {
                expect(toCents(fromCents(store.cents))).toBe(store.cents)
            }
        }
    })
})

// F-15. The app shipped with no security headers at all and advertised its
// framework in every response.
describe('security response headers', () => {
    const config = nextConfig
    let headers

    beforeEach(async () => {
        const rules = await config.headers()
        headers = Object.fromEntries(rules[0].headers.map(h => [h.key, h.value]))
    })

    it('applies to every path', async () => {
        const rules = await config.headers()
        expect(rules).toHaveLength(1)
        expect(rules[0].source).toBe('/:path*')
    })

    it('stops advertising the framework', () => {
        expect(config.poweredByHeader).toBe(false)
    })

    it('sets each of the five headers the audit called for', () => {
        expect(headers['Strict-Transport-Security']).toMatch(/max-age=\d{7,}/)
        expect(headers['X-Content-Type-Options']).toBe('nosniff')
        expect(headers['X-Frame-Options']).toBe('DENY')
        expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
        expect(headers['Content-Security-Policy']).toBeDefined()
    })

    it('does not commit the domain to the HSTS preload list', () => {
        // Preloading is enforced by browser vendors and is painful to undo;
        // that is a deployment decision, not a config-file default.
        expect(headers['Strict-Transport-Security']).not.toMatch(/preload/)
    })

    it('refuses framing in both the modern and the legacy header', () => {
        // Nothing frames this app, and the checkout and admin console are what
        // clickjacking would target.
        expect(headers['X-Frame-Options']).toBe('DENY')
        expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    })

    it('enforces only the directive that cannot break the app', () => {
        // The resource policy is unverified against a real browser, so it is
        // report-only. Enforcing it must be a deliberate promotion, not a drift.
        expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'none'")
        expect(headers['Content-Security-Policy-Report-Only']).toBeDefined()
    })

    it('allows every origin the app genuinely needs', () => {
        const reportOnly = headers['Content-Security-Policy-Report-Only']
        // Derived from the code: a missing origin here becomes an outage the
        // day this policy is enforced.
        expect(reportOnly).toContain('https://ik.imagekit.io')          // product images
        expect(reportOnly).toContain('https://*.clerk.accounts.dev')    // auth SDK
        expect(reportOnly).toContain('https://challenges.cloudflare.com') // Clerk bot check
        expect(reportOnly).toContain('https://rzp.io')                   // checkout redirect
        expect(reportOnly).toMatch(/worker-src [^;]*blob:/)             // Clerk workers
    })

    it('keeps the dangerous directives closed', () => {
        const reportOnly = headers['Content-Security-Policy-Report-Only']
        expect(reportOnly).toContain("object-src 'none'")
        expect(reportOnly).toContain("base-uri 'self'")
        expect(reportOnly).toContain("default-src 'self'")
        // Inline *scripts* are unavoidable in the App Router; inline styles are
        // React's. Neither should quietly become a wildcard host.
        expect(reportOnly).not.toMatch(/script-src[^;]*\*(?!\.clerk)/)
        expect(reportOnly).not.toContain("'unsafe-eval'")
    })
})

// Postgres does not index a foreign key automatically, and none were, so every
// seller and buyer query was a sequential scan. Checked against the migrations.
describe('foreign key indexes', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const migrationsDir = resolve(root, 'prisma/migrations')

    const sql = readdirSync(migrationsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))          // applied in order
        .map(e => readFileSync(resolve(migrationsDir, e.name, 'migration.sql'), 'utf8'))
        .join('\n')

    // Every (table, column) a foreign key constrains.
    const foreignKeys = [...sql.matchAll(
        /ALTER TABLE "public"\."(\w+)" ADD CONSTRAINT "\w+" FOREIGN KEY \("(\w+)"\)/g
    )].map(([, table, column]) => `${table}.${column}`)

    // A column is covered when it *leads* an index. Applied in order and
    // honouring DROP INDEX, so this is the schema as it ends up, not every
    // index ever written.
    const indexes = new Map()                  // index name -> "Table.leadingColumn"
    const plainIndexes = new Map()             // the same, excluding UNIQUE
    const covered = new Set()

    for (const [, table, body] of sql.matchAll(/CREATE TABLE "public"\."(\w+)" \(([\s\S]*?)\n\);/g)) {
        const pk = body.match(/PRIMARY KEY \("(\w+)"/)
        if (pk) covered.add(`${table}.${pk[1]}`)
    }
    for (const [, unique, name, table, first] of sql.matchAll(
        /CREATE (UNIQUE )?INDEX "(\w+)" ON "public"\."(\w+)"\("(\w+)"/g
    )) {
        indexes.set(name, `${table}.${first}`)
        if (!unique) plainIndexes.set(name, `${table}.${first}`)
    }
    for (const [, name] of sql.matchAll(/DROP INDEX "public"\."(\w+)"/g)) {
        indexes.delete(name)
        plainIndexes.delete(name)
    }
    for (const value of indexes.values()) covered.add(value)

    it('found the foreign keys and indexes to check', () => {
        // Guards the parser itself: a regex that silently matches nothing would
        // make every assertion below vacuously true.
        expect(foreignKeys.length).toBeGreaterThanOrEqual(10)
        expect(foreignKeys).toContain('Order.userId')
        expect(covered.size).toBeGreaterThanOrEqual(10)
    })

    it('indexes every foreign key column', () => {
        const unindexed = foreignKeys.filter(fk => !covered.has(fk))
        expect(unindexed).toEqual([])
    })

    it('does not add an index that merely duplicates an existing one', () => {
        // OrderItem.orderId leads the primary key and Rating.userId the unique
        // constraint, so separate indexes would cost writes and buy nothing.
        // Surviving indexes only: one replaced by a composite is not a duplicate.
        const explicit = [...plainIndexes.values()]

        expect(explicit).not.toContain('OrderItem.orderId')
        expect(explicit).not.toContain('Rating.userId')
        expect(explicit).not.toContain('Store.userId')
        expect(new Set(explicit).size).toBe(explicit.length)   // no duplicates
    })
})

// `npm audit` in CI catches *new* advisories; these lock in the fixes already
// made, so a revert cannot silently reintroduce them.
describe('dependency floors', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))

    // "^15.5.23" -> [15, 5, 23]. Rejects an exact pin, which cannot take patches.
    const floorOf = (range) => {
        const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
        if (!m) throw new Error(`expected a caret range, got "${range}"`)
        return m.slice(1).map(Number)
    }
    const atLeast = (actual, min) => {
        for (let i = 0; i < 3; i++) {
            if (actual[i] > min[i]) return true
            if (actual[i] < min[i]) return false
        }
        return true
    }
    const installed = (name) => {
        const entry = Object.entries(lock.packages)
            .find(([path]) => path === `node_modules/${name}`)
        if (!entry) throw new Error(`${name} not found in package-lock.json`)
        return entry[1].version.split('.').map(Number)
    }

    // GHSA-9qr9-h5gf-34mp (RCE), GHSA-267c-6grr-h53f (middleware bypass) and
    // ~28 others are fixed in 15.5.23. A caret range keeps future patches flowing.
    it('next is a caret range at or above the patched 15.5.23', () => {
        expect(atLeast(floorOf(manifest.dependencies.next), [15, 5, 23])).toBe(true)
        expect(atLeast(installed('next'), [15, 5, 23])).toBe(true)
    })

    // next pins postcss exactly and sharp to ^0.34.3, so both need an override
    // to reach a patched version without taking a major framework upgrade.
    it('holds transitive overrides for the deps next pins to vulnerable versions', () => {
        expect(manifest.overrides).toBeDefined()
        // GHSA-qx2v-qp2m-jg93 and the sourceMappingURL path-traversal advisories.
        expect(atLeast(installed('postcss'), [8, 5, 23])).toBe(true)
        // GHSA-f88m-g3jw-g9cj — libvips CVEs.
        expect(atLeast(installed('sharp'), [0, 35, 3])).toBe(true)
        // GHSA-w5hq-g745-h8pq — imagekit depends on uuid ^8.
        expect(atLeast(installed('uuid'), [11, 1, 1])).toBe(true)
    })

    it('every resolved copy of an overridden package is patched, not just the top one', () => {
        const floors = { postcss: [8, 5, 23], sharp: [0, 35, 3], uuid: [11, 1, 1] }
        for (const [path, meta] of Object.entries(lock.packages)) {
            const name = path.split('node_modules/').pop()
            if (!floors[name] || !meta.version) continue
            expect(
                atLeast(meta.version.split('.').map(Number), floors[name]),
                `${path} resolved to ${meta.version}`,
            ).toBe(true)
        }
    })
})

// ONLINE_PAYMENT_METHODS holds plain strings, because a client component
// imports it and @prisma/client cannot reach the browser. That severs the
// compile-time tie to the schema, so it is re-tied here.
describe('online payment methods match the schema enum', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')

    const declared = schema
        .match(/enum PaymentMethod \{([^}]*)\}/)[1]
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'))

    it('names only values the schema declares', async () => {
        const { ONLINE_PAYMENT_METHODS, ACTIVE_ONLINE_METHOD } = await import('@/lib/onlinePayment')
        for (const method of ONLINE_PAYMENT_METHODS) expect(declared).toContain(method)
        expect(declared).toContain(ACTIVE_ONLINE_METHOD)
    })

    it('covers every declared value that is not COD', async () => {
        const { ONLINE_PAYMENT_METHODS } = await import('@/lib/onlinePayment')
        // A provider added to the schema and forgotten here would be treated as
        // pay-on-delivery: its orders would count as placed before payment.
        expect([...ONLINE_PAYMENT_METHODS].sort()).toEqual(declared.filter(v => v !== 'COD').sort())
    })

    it('treats the active provider as an online method', async () => {
        const { ACTIVE_ONLINE_METHOD, isOnlineMethod } = await import('@/lib/onlinePayment')
        expect(isOnlineMethod(ACTIVE_ONLINE_METHOD)).toBe(true)
        expect(isOnlineMethod('COD')).toBe(false)
        expect(isOnlineMethod(undefined)).toBe(false)
    })
})

describe('razorpay webhook signatures', () => {
    const secret = 'whsec'
    const body = '{"event":"payment_link.paid"}'
    const digest = (b, s = secret) => createHmac('sha256', s).update(b).digest('hex')

    it('accepts a digest of the exact bytes signed', async () => {
        const { verifyWebhookSignature } = await import('@/lib/razorpaySignature')
        expect(verifyWebhookSignature(body, digest(body), secret)).toBe(true)
    })

    it('rejects a body altered after signing', async () => {
        const { verifyWebhookSignature } = await import('@/lib/razorpaySignature')
        expect(verifyWebhookSignature(`${body} `, digest(body), secret)).toBe(false)
    })

    it('rejects a digest made with a different secret', async () => {
        const { verifyWebhookSignature } = await import('@/lib/razorpaySignature')
        expect(verifyWebhookSignature(body, digest(body, 'other'), secret)).toBe(false)
    })

    it('returns false rather than throwing on a missing or malformed signature', async () => {
        const { verifyWebhookSignature } = await import('@/lib/razorpaySignature')
        // timingSafeEqual throws on a length mismatch, so a short signature
        // must be answered before it is reached.
        for (const sig of [undefined, null, '', 'abc', digest(body).slice(0, -1)]) {
            expect(verifyWebhookSignature(body, sig, secret)).toBe(false)
        }
        expect(verifyWebhookSignature(body, digest(body), undefined)).toBe(false)
        expect(verifyWebhookSignature(undefined, digest(body), secret)).toBe(false)
    })
})
