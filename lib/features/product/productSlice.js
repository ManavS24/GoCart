import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import axios from 'axios'

// The catalogue arrives a page at a time. `list` is the page being browsed;
// `byId` holds every product seen, including ones fetched for a basket whose
// items have scrolled off it -- without which paginating would empty carts.
export const fetchProducts = createAsyncThunk('product/fetchProducts',
    async ({ search, cursor } = {}, thunkAPI) => {
        try {
            const params = new URLSearchParams()
            if (search) params.set('search', search)
            if (cursor) params.set('cursor', cursor)

            const { data } = await axios.get(`/api/products?${params}`)
            return { ...data, append: Boolean(cursor) }
        } catch (error) {
            return thunkAPI.rejectWithValue(error.response?.data ?? { error: error.message })
        }
    }
)

// Resolves specific products without disturbing the page being browsed.
export const fetchProductsByIds = createAsyncThunk('product/fetchProductsByIds',
    async ({ ids }, thunkAPI) => {
        try {
            if (!ids?.length) return { products: [] }
            const { data } = await axios.get(`/api/products?ids=${ids.join(',')}`)
            return data
        } catch (error) {
            return thunkAPI.rejectWithValue(error.response?.data ?? { error: error.message })
        }
    }
)

const index = (state, products) => {
    for (const product of products) state.byId[product.id] = product
}

const productSlice = createSlice({
    name: 'product',
    initialState: {
        list: [],
        byId: {},
        nextCursor: null,
        status: 'idle',
    },
    reducers: {},
    extraReducers: (builder) => {
        builder
            .addCase(fetchProducts.pending, (state) => {
                state.status = 'loading'
            })
            .addCase(fetchProducts.fulfilled, (state, action) => {
                const products = action.payload?.products ?? []
                // A cursor extends the page; anything else replaces it.
                state.list = action.payload?.append ? [...state.list, ...products] : products
                state.nextCursor = action.payload?.nextCursor ?? null
                state.status = 'loaded'
                index(state, products)
            })
            .addCase(fetchProducts.rejected, (state) => {
                state.status = 'failed'
            })
            .addCase(fetchProductsByIds.fulfilled, (state, action) => {
                // Indexed but not listed: these were asked for by id, not browsed.
                index(state, action.payload?.products ?? [])
            })
    }
})

export default productSlice.reducer
