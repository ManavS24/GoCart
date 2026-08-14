'use client'
import { formatAmount } from '@/lib/formatPrice'
import Counter from "@/components/Counter";
import Loading from "@/components/Loading";
import OrderSummary from "@/components/OrderSummary";
import PageTitle from "@/components/PageTitle";
import { deleteItemFromCart } from "@/lib/features/cart/cartSlice";
import { fetchProductsByIds } from "@/lib/features/product/productSlice";
import { Trash2Icon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

export default function Cart() {

    const currency = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '$';
    
    const { cartItems } = useSelector(state => state.cart);
    // Keyed by id, not the page being browsed: a basket outlives it.
    const productsById = useSelector(state => state.product.byId);

    const dispatch = useDispatch();

    const [cartArray, setCartArray] = useState([]);
    const [totalPrice, setTotalPrice] = useState(0);

    // An empty cartArray means one of two different things: a genuinely empty
    // basket, or one whose products have not arrived yet. Saying "empty" for
    // the second is what made a full cart look cleared on reload.
    const itemCount = Object.keys(cartItems).length;
    const awaitingProducts = itemCount > 0 && cartArray.length === 0;

    const createCartArray = () => {
        setTotalPrice(0);
        const cartArray = [];
        for (const [key, value] of Object.entries(cartItems)) {
            const product = productsById[key];
            if (product) {
                cartArray.push({
                    ...product,
                    quantity: value,
                });
                setTotalPrice(prev => prev + product.price * value);
            }
        }
        setCartArray(cartArray);
    }

    const handleDeleteItemFromCart = (productId) => {
        dispatch(deleteItemFromCart({ productId }))
    }

    // Fetched by id, so a paged catalogue cannot make a cart look emptier.
    useEffect(() => {
        const missing = Object.keys(cartItems).filter(id => !productsById[id]);
        if (missing.length > 0) dispatch(fetchProductsByIds({ ids: missing }));
    }, [cartItems, productsById, dispatch]);

    useEffect(() => {
        createCartArray();
    }, [cartItems, productsById]);

    if (awaitingProducts) return <Loading />

    return cartArray.length > 0 ? (
        <div className="min-h-screen mx-6 text-slate-800">

            <div className="max-w-7xl mx-auto ">
                <PageTitle heading="My Cart" text={`${cartArray.length} ${cartArray.length === 1 ? 'item' : 'items'} in your cart`} path="/shop" linkText="Add more" />

                <div className="flex items-start justify-between gap-5 max-lg:flex-col">

                    <table className="w-full max-w-4xl text-slate-600 table-auto">
                        <thead>
                            <tr className="max-sm:text-sm">
                                <th className="text-left">Product</th>
                                <th>Quantity</th>
                                <th>Total Price</th>
                                <th className="max-md:hidden">Remove</th>
                            </tr>
                        </thead>
                        <tbody>
                            {
                                cartArray.map((item, index) => (
                                    <tr key={index} className="space-x-2">
                                        <td className="flex gap-3 my-4">
                                            <div className="flex gap-3 items-center justify-center bg-slate-100 size-18 rounded-md">
                                                <Image src={item.images[0]} className="h-14 w-auto" alt={item.name} width={45} height={45} />
                                            </div>
                                            <div>
                                                <p className="max-sm:text-sm">{item.name}</p>
                                                <p className="text-xs text-slate-500">{item.category}</p>
                                                <p>{currency}{formatAmount(item.price)}</p>
                                            </div>
                                        </td>
                                        <td className="text-center">
                                            <Counter productId={item.id} />
                                        </td>
                                        <td className="text-center">{currency}{formatAmount(item.price * item.quantity)}</td>
                                        <td className="text-center max-md:hidden">
                                            <button onClick={() => handleDeleteItemFromCart(item.id)} className=" text-red-500 hover:bg-red-50 p-2.5 rounded-full active:scale-95 transition-all">
                                                <Trash2Icon size={18} />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            }
                        </tbody>
                    </table>
                    <OrderSummary totalPrice={totalPrice} items={cartArray} />
                </div>
            </div>
        </div>
    ) : (
        <div className="min-h-[80vh] mx-6 flex flex-col items-center justify-center text-center">
            <h1 className="text-2xl sm:text-4xl font-semibold text-slate-400">Your cart is empty</h1>
            <p className="text-slate-500 mt-3">Browse the catalogue and add something you like.</p>
            <Link href="/shop" className="mt-7 bg-slate-800 text-white px-10 py-2.5 text-sm rounded hover:bg-slate-900 active:scale-95 transition">
                Continue shopping
            </Link>
        </div>
    )
}