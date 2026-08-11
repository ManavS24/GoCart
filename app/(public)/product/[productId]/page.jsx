'use client'
import Loading from "@/components/Loading";
import ProductDescription from "@/components/ProductDescription";
import ProductDetails from "@/components/ProductDetails";
import axios from "axios";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function Product() {

    const { productId } = useParams();
    const [product, setProduct] = useState(null);
    // Without this the page cannot tell "still arriving" from "does not exist".
    const [status, setStatus] = useState('loading');

    useEffect(() => {
        let cancelled = false

        // By id, so the page does not wait on the whole catalogue.
        const fetchProduct = async () => {
            setStatus('loading')
            try {
                const { data } = await axios.get(`/api/products/${productId}`)
                if (cancelled) return
                setProduct(data.product)
                setStatus('found')
            } catch {
                if (cancelled) return
                setStatus('missing')
            }
        }

        fetchProduct()
        scrollTo(0, 0)
        return () => { cancelled = true }
    }, [productId]);

    if (status === 'loading') return <Loading />

    if (status === 'missing') {
        return (
            <div className="min-h-[70vh] mx-6 flex items-center justify-center text-slate-400">
                <h1 className="text-2xl sm:text-4xl font-semibold">This product is no longer available</h1>
            </div>
        )
    }

    return (
        <div className="mx-6">
            <div className="max-w-7xl mx-auto">

                <div className="  text-gray-600 text-sm mt-8 mb-5">
                    Home / Products / {product?.category}
                </div>

                {product && (<ProductDetails product={product} />)}

                {product && (<ProductDescription product={product} />)}
            </div>
        </div>
    );
}
