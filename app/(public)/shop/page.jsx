'use client'
import { Suspense, useEffect } from "react"
import ProductCard from "@/components/ProductCard"
import { MoveLeftIcon } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { useDispatch, useSelector } from "react-redux"
import { fetchProducts } from "@/lib/features/product/productSlice"

 function ShopContent() {

    const searchParams = useSearchParams()
    const search = searchParams.get('search')
    const router = useRouter()

    const dispatch = useDispatch()
    const products = useSelector(state => state.product.list)
    const nextCursor = useSelector(state => state.product.nextCursor)
    const status = useSelector(state => state.product.status)

    // On the server: filtering the loaded page misses anything further in.
    useEffect(() => {
        dispatch(fetchProducts({ search: search || undefined }))
    }, [dispatch, search])

    const filteredProducts = products;

    return (
        <div className="min-h-[70vh] mx-6">
            <div className=" max-w-7xl mx-auto">
                <h1 onClick={() => router.push('/shop')} className="text-2xl text-slate-500 my-6 flex items-center gap-2 cursor-pointer"> {search && <MoveLeftIcon size={20} />}  All <span className="text-slate-700 font-medium">Products</span></h1>
                <div className="grid grid-cols-2 sm:flex flex-wrap gap-6 xl:gap-12 mx-auto">
                    {filteredProducts.map((product) => <ProductCard key={product.id} product={product} />)}
                </div>

                {filteredProducts.length === 0 && status === 'loaded' && (
                    <p className="text-slate-400 my-16 text-center">No products found.</p>
                )}

                {/* The catalogue is paged; without this, page one is all there is. */}
                <div className="flex justify-center my-16">
                    {nextCursor && (
                        <button
                            onClick={() => dispatch(fetchProducts({ search: search || undefined, cursor: nextCursor }))}
                            disabled={status === 'loading'}
                            className="border border-slate-300 px-8 py-2 rounded text-slate-600 hover:bg-slate-50 active:scale-95 transition disabled:opacity-60"
                        >{status === 'loading' ? 'Loading…' : 'Load more'}</button>
                    )}
                </div>
            </div>
        </div>
    )
}


export default function Shop() {
  return (
    <Suspense fallback={<div>Loading shop...</div>}>
      <ShopContent />
    </Suspense>
  );
}