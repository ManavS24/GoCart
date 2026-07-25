import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import axios from 'axios'

export const fetchProducts = createAsyncThunk('product/fetchProducts',
    async (_, thunkAPI) => {
        try {
            const { data } = await axios.get('/api/products')
            return data.products
        } catch (error) {
            return thunkAPI.rejectWithValue(error.response?.data ?? { error: error.message })
        }
    }
)

const productSlice = createSlice({
    name: 'product',
    initialState: {
        list: [],
    },
    reducers: {},
    extraReducers: (builder)=>{
        builder.addCase(fetchProducts.fulfilled, (state, action)=>{
            state.list = action.payload ?? []
        })
    }
})

export default productSlice.reducer