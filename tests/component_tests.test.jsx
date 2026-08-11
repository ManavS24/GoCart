// @vitest-environment jsdom
//
// Every earlier client finding was proven against the Redux store or a pure
// function, never a rendered component. These close that gap for the parts
// carrying money or data loss.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

const axiosGet = vi.fn()
const axiosPost = vi.fn()

vi.mock('axios', () => ({
    default: { get: (...a) => axiosGet(...a), post: (...a) => axiosPost(...a) },
}))

// Clerk renders its own tree and talks to its API; the components under test
// only care whether a user is present and what plan they hold.
vi.mock('@clerk/nextjs', () => ({
    useUser: () => ({ user: { id: 'u1' }, isLoaded: true }),
    useAuth: () => ({ getToken: async () => 'tok', isLoaded: true }),
    Protect: ({ children, fallback }) => fallback ?? children,
    PricingTable: () => null,
}))

const pushed = []
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: (p) => pushed.push(p) }),
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
}))

vi.mock('react-hot-toast', () => {
    const toast = Object.assign((m) => m, {
        success: vi.fn(), error: vi.fn(),
        promise: (p) => p,
    })
    return { default: toast, __esModule: true }
})

const cartReducer = (await import('@/lib/features/cart/cartSlice')).default
const productReducer = (await import('@/lib/features/product/productSlice')).default
const addressReducer = (await import('@/lib/features/address/addressSlice')).default
const ratingReducer = (await import('@/lib/features/rating/ratingSlice')).default

const { default: ProductCard } = await import('@/components/ProductCard')
const { default: OrderSummary } = await import('@/components/OrderSummary')

const makeTestStore = (preloadedState) => configureStore({
    reducer: { cart: cartReducer, product: productReducer, address: addressReducer, rating: ratingReducer },
    preloadedState,
})

const renderWith = (ui, preloadedState) => {
    const store = makeTestStore(preloadedState)
    return { store, ...render(<Provider store={store}>{ui}</Provider>) }
}

beforeEach(() => { vi.clearAllMocks(); pushed.length = 0 })
afterEach(() => cleanup())

describe('ProductCard', () => {
    const product = {
        id: 'p1', name: 'Modern Table Lamp', price: 29, images: ['/lamp.png'],
    }

    it('renders a rating from the catalogue’s aggregate', () => {
        // The catalogue now sends an average rather than every review; a card
        // that still expected the array would divide by zero and render NaN.
        renderWith(<ProductCard product={{ ...product, ratingAverage: 4.4, ratingCount: 7 }} />)
        expect(screen.getByText('Modern Table Lamp')).toBeDefined()
    })

    it('renders a product that has never been reviewed', () => {
        // `rating.reduce(...) / rating.length` on an empty array is NaN, which
        // used to reach the star row.
        const { container } = renderWith(<ProductCard product={{ ...product, ratingAverage: 0, ratingCount: 0 }} />)
        expect(container.textContent).not.toContain('NaN')
    })

    it('still renders when given the product page’s shape', () => {
        // The by-id endpoint returns the reviews themselves. Both shapes reach
        // this component, so it must handle either.
        const { container } = renderWith(<ProductCard product={{ ...product, rating: [{ rating: 5 }, { rating: 3 }] }} />)
        expect(container.textContent).not.toContain('NaN')
        expect(screen.getByText('Modern Table Lamp')).toBeDefined()
    })
})

describe('OrderSummary', () => {
    const items = [{ id: 'p1', name: 'Lamp', price: 10, quantity: 2, storeId: 's1' }]
    const state = {
        address: { list: [{ id: 'addr_1', name: 'Ada', city: 'London', state: 'X', zip: '1' }] },
        cart: { total: 2, cartItems: { p1: 2 }, status: 'loaded', syncError: null },
    }

    it('shows a total computed by the shared pricing function', () => {
        // The summary and the checkout price the same basket; this is the number
        // a shopper is asked to agree to.
        const { container } = renderWith(<OrderSummary totalPrice={20} items={items} />, state)
        expect(container.textContent).toContain('25.00')      // 20 + 5 shipping
    })

    it('disables the button while an order is in flight', async () => {
        // F-17's client half, previously correct only by inspection: a
        // double-click is the ordinary way to create two baskets.
        let resolvePost
        axiosPost.mockReturnValue(new Promise(r => { resolvePost = r }))

        const { container } = renderWith(<OrderSummary totalPrice={20} items={items} />, state)
        const select = container.querySelector('select')
        select.value = '0'
        select.dispatchEvent(new Event('change', { bubbles: true }))

        const button = screen.getByRole('button', { name: /place order/i })
        button.click()

        await waitFor(() => expect(button.disabled).toBe(true))
        expect(button.textContent).toMatch(/placing/i)

        resolvePost({ data: { message: 'Orders Placed Successfully' } })
        await waitFor(() => expect(button.disabled).toBe(false))
    })

    it('sends one idempotency key, and the same one, for repeated clicks', async () => {
        // A key generated per click would differ each time and deduplicate
        // nothing -- the exact mistake the server-side fix depends on avoiding.
        axiosPost.mockRejectedValue(new Error('network'))

        const { container } = renderWith(<OrderSummary totalPrice={20} items={items} />, state)
        const select = container.querySelector('select')
        select.value = '0'
        select.dispatchEvent(new Event('change', { bubbles: true }))

        const button = screen.getByRole('button', { name: /place order/i })
        button.click()
        await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1))
        button.click()
        await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(2))

        const keys = axiosPost.mock.calls.map(c => c[2]?.headers?.['Idempotency-Key'])
        expect(keys[0]).toBeTruthy()
        expect(keys[0]).toBe(keys[1])
    })

    it('refuses to submit without an address', async () => {
        renderWith(<OrderSummary totalPrice={20} items={items} />, state)
        screen.getByRole('button', { name: /place order/i }).click()
        await waitFor(() => expect(axiosPost).not.toHaveBeenCalled())
    })
})
