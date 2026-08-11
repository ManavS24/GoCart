import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import axios from 'axios'

const DEBOUNCE_MS = 1000
const RETRY_DELAY_MS = 2000

let debounceTimer = null
let supersedeWait = null

// Awaited by the thunk rather than run inside it: a request started from a
// `setTimeout` callback settles after the thunk has returned, so nothing could
// observe it failing. A superseded wait resolves rather than hanging forever.
const waitForQuiet = () => new Promise((resolve) => {
    if (supersedeWait) supersedeWait('superseded')
    clearTimeout(debounceTimer)
    supersedeWait = resolve
    debounceTimer = setTimeout(() => {
        supersedeWait = null
        resolve('due')
    }, DEBOUNCE_MS)
})

export const uploadCart = createAsyncThunk('cart/uploadCart',
    async ({ getToken }, thunkAPI) => {
        try {
            if (await waitForQuiet() !== 'due') return { skipped: 'superseded' }

            const { cartItems, status } = thunkAPI.getState().cart;
            // Only a cart that has been read back may be written; until then
            // the state is the empty initial value. Checked after the wait, so
            // an upload queued during loading still succeeds once it arrives.
            if (status !== 'loaded') return { skipped: 'not-loaded' }

            const token = await getToken();

            // One retry: a cart write is cheap, and the alternative is losing
            // the basket to a single unlucky request.
            try {
                await axios.post('/api/cart', {cart: cartItems}, { headers: { Authorization: `Bearer ${token}` } })
            } catch (error) {
                // A refusal is not transient: retrying a 4xx just fails again.
                const status = error?.response?.status
                if (status && status >= 400 && status < 500) throw error
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                await axios.post('/api/cart', {cart: cartItems}, { headers: { Authorization: `Bearer ${token}` } })
            }

            return { saved: true }
        } catch (error) {
            return thunkAPI.rejectWithValue(error.response?.data ?? { error: error.message })
        }
    }
)

export const fetchCart = createAsyncThunk('cart/fetchCart', 
    async ({ getToken }, thunkAPI) => {
        try {
            const token = await getToken()
            const { data } = await axios.get('/api/cart', {headers: { Authorization: `Bearer ${token}` }})
            return data
        } catch (error) {
            return thunkAPI.rejectWithValue(error.response?.data ?? { error: error.message })
        }
    }
)


const cartSlice = createSlice({
    name: 'cart',
    initialState: {
        total: 0,
        cartItems: {},
        // 'idle' | 'loading' | 'loaded' | 'failed'. An empty cartItems alone
        // cannot distinguish an empty basket from an unfetched one, and
        // writing back the second case wiped saved carts on a cold start.
        status: 'idle',
        // Last failed write-back, or null. A cart that has stopped syncing is
        // otherwise indistinguishable from one that is saving fine, which is
        // how a broken sync stayed invisible.
        syncError: null,
    },
    reducers: {
        addToCart: (state, action) => {
            const { productId } = action.payload
            if (state.cartItems[productId]) {
                state.cartItems[productId]++
            } else {
                state.cartItems[productId] = 1
            }
            state.total += 1
        },
        removeFromCart: (state, action) => {
            const { productId } = action.payload
            // Decrement stays inside the guard so total tracks cartItems exactly.
            if (state.cartItems[productId]) {
                state.cartItems[productId]--
                if (state.cartItems[productId] === 0) {
                    delete state.cartItems[productId]
                }
                state.total -= 1
            }
        },
        deleteItemFromCart: (state, action) => {
            const { productId } = action.payload
            state.total -= state.cartItems[productId] ? state.cartItems[productId] : 0
            delete state.cartItems[productId]
        },
    },
    extraReducers: (builder)=>{
        builder
            .addCase(fetchCart.pending, (state)=>{
                state.status = 'loading'
            })
            .addCase(fetchCart.fulfilled, (state, action)=>{
                // A brand new account has no cart yet; treat a missing payload as empty.
                const cart = action.payload?.cart ?? {}
                state.cartItems = cart
                state.total = Object.values(cart).reduce((acc, item)=>acc + item, 0)
                state.status = 'loaded'
            })
            .addCase(fetchCart.rejected, (state)=>{
                // The saved cart is unknown, not empty. Staying out of 'loaded'
                // keeps uploads blocked rather than overwriting it with guesses.
                state.status = 'failed'
            })
            .addCase(uploadCart.fulfilled, (state)=>{
                state.syncError = null
            })
            .addCase(uploadCart.rejected, (state, action)=>{
                state.syncError = action.payload?.error ?? 'Cart could not be saved'
            })
    }
})

export const { addToCart, removeFromCart, deleteItemFromCart } = cartSlice.actions

export default cartSlice.reducer
