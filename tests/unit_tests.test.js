// Every module in isolation; Prisma, Clerk and axios are mocked at the boundary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
    const asUser = (email) => ({ emailAddresses: [{ emailAddress: email }] })

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

    it('returns the store id for an approved store', async () => {
        prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status: 'approved' } })
        await expect(authSeller('u1')).resolves.toBe('store_1')
    })

    // Prisma silently drops an `undefined` storeId from a `where` clause.
    for (const status of ['pending', 'rejected', 'suspended', '']) {
        it(`returns false (never undefined) for status "${status}"`, async () => {
            prisma.user.findUnique.mockResolvedValue({ store: { id: 'store_1', status } })
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
            expect(s).toEqual({ total: 0, cartItems: {} })
        }
    })

    it('no longer exports the unused clearCart action', () => {
        expect(cart.clearCart).toBeUndefined()
    })
})

describe('cartSlice uploadCart thunk', () => {
    beforeEach(() => { vi.clearAllMocks(); silence(); vi.useFakeTimers() })
    afterEach(() => vi.useRealTimers())

    it('debounces rapid dispatches into a single POST', async () => {
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })
        const getToken = async () => 'tok'

        store.dispatch(cart.addToCart({ productId: 'p1' }))
        for (let i = 0; i < 5; i++) store.dispatch(cart.uploadCart({ getToken }))

        expect(axiosPost).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost).toHaveBeenCalledTimes(1)
    })

    it('posts the latest cart state, not the state at dispatch time', async () => {
        const store = makeStore()
        axiosPost.mockResolvedValue({ data: {} })
        store.dispatch(cart.uploadCart({ getToken: async () => 'tok' }))
        store.dispatch(cart.addToCart({ productId: 'late' }))

        await vi.advanceTimersByTimeAsync(1100)
        expect(axiosPost.mock.calls[0][1]).toEqual({ cart: { late: 1 } })
    })
})

describe('productSlice reducer', () => {
    it('starts empty and hydrates from fetchProducts', () => {
        const initial = product.default(undefined, { type: '@@INIT' })
        expect(initial).toEqual({ list: [] })
        const s = product.default(initial, { type: product.fetchProducts.fulfilled.type, payload: [{ id: 'p1' }] })
        expect(s.list).toHaveLength(1)
    })

    it('coerces a missing payload to an empty list rather than undefined', () => {
        const s = product.default({ list: [] }, { type: product.fetchProducts.fulfilled.type, payload: undefined })
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
            cart: { total: 0, cartItems: {} },
            product: { list: [] },
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
