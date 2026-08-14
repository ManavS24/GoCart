'use client'
import Banner from "@/components/Banner";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useUser, useAuth } from "@clerk/nextjs";
import { fetchCart, uploadCart } from "@/lib/features/cart/cartSlice";
import { fetchAddress } from "@/lib/features/address/addressSlice";
import { fetchUserRatings } from "@/lib/features/rating/ratingSlice";

export default function PublicLayout({ children }) {

    const dispatch = useDispatch()
    const {user} = useUser()
    const {getToken} = useAuth()

    const {cartItems, syncError} = useSelector((state)=>state.cart)

    useEffect(()=>{
        if(user){
            dispatch(fetchCart({getToken}))
            dispatch(fetchAddress({getToken}))
            dispatch(fetchUserRatings({getToken}))
        }
    },[user])

    useEffect(()=>{
        if(user){
            dispatch(uploadCart({getToken}))
        }
    },[cartItems])




    return (
        <>
            <Banner />
            <Navbar />
            {/* A stalled sync is otherwise invisible. The basket still works. */}
            {syncError && (
                <div role="status" className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm text-center py-2 px-4">
                    Your cart could not be saved. It still works here, but may not
                    follow you to another device.
                </div>
            )}
            {children}
            <Footer />
        </>
    );
}
