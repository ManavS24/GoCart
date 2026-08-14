'use client'
import BestSelling from "@/components/BestSelling";
import Hero from "@/components/Hero";
import Newsletter from "@/components/Newsletter";
import OurSpecs from "@/components/OurSpec";
import LatestProducts from "@/components/LatestProducts";
import { useEffect } from "react";
import { useDispatch } from "react-redux";
import { fetchProducts } from "@/lib/features/product/productSlice";

export default function Home() {

    const dispatch = useDispatch()

    // The catalogue is fetched by the pages that show it, not by the layout:
    // a shared fetch overwrote the shop page's filtered results.
    useEffect(() => {
        dispatch(fetchProducts({}))
    }, [dispatch])

    return (
        <div>
            <Hero />
            <LatestProducts />
            <BestSelling />
            <OurSpecs />
            <Newsletter />
        </div>
    );
}
