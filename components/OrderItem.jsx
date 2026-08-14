'use client'
import { formatAmount } from '@/lib/formatPrice'
import { paymentLabel, statusLabel, statusStyle } from '@/lib/orderDisplay'
import Image from "next/image";
import { DotIcon } from "lucide-react";
import { useSelector } from "react-redux";
import Rating from "./Rating";
import { useState } from "react";
import RatingModal from "./RatingModal";

const OrderItem = ({ order }) => {

    const currency = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '$';
    const [ratingModal, setRatingModal] = useState(null);

    const { ratings } = useSelector(state => state.rating);

    // Buyers previously saw no payment information at all, which matters when
    // an online payment is confirmed by a sweep rather than instantly.
    const payment = paymentLabel(order);

    return (
        <>
            <tr className="text-sm">
                <td className="text-left">
                    <div className="flex flex-col gap-6">
                        {order.orderItems.map((item, index) => (
                            <div key={index} className="flex items-center gap-4">
                                <div className="w-20 aspect-square bg-slate-100 flex items-center justify-center rounded-md">
                                    <Image
                                        className="h-14 w-auto"
                                        src={item.product.images[0]}
                                        alt="product_img"
                                        width={50}
                                        height={50}
                                    />
                                </div>
                                <div className="flex flex-col justify-center text-sm">
                                    <p className="font-medium text-slate-600 text-base">{item.product.name}</p>
                                    <p>{currency}{formatAmount(item.price)} Qty : {item.quantity} </p>
                                    <p className="mb-1">{new Date(order.createdAt).toDateString()}</p>
                                    <div>
                                        {ratings.find(rating => order.id === rating.orderId && item.product.id === rating.productId)
                                            ? <Rating value={ratings.find(rating => order.id === rating.orderId && item.product.id === rating.productId).rating} />
                                            : <button onClick={() => setRatingModal({ orderId: order.id, productId: item.product.id })} className={`text-green-500 hover:bg-green-50 transition ${order.status !== "DELIVERED" && 'hidden'}`}>Rate Product</button>
                                        }</div>
                                </div>
                            </div>
                        ))}
                        {/* Outside the loop: one modal per order, not per line item. */}
                        {ratingModal && <RatingModal ratingModal={ratingModal} setRatingModal={setRatingModal} />}
                    </div>
                </td>

                <td className="text-center max-md:hidden">{currency}{formatAmount(order.total)}</td>

                <td className="text-left max-md:hidden">
                    <p>{order.address.name}, {order.address.street}</p>
                    <p>{order.address.city}, {order.address.state} {order.address.zip}, {order.address.country}</p>
                    <p>{order.address.phone}</p>
                </td>

                <td className="text-left space-y-2 text-sm max-md:hidden">
                    <div className={`flex items-center justify-center gap-1 rounded-full p-1 ${statusStyle(order.status)}`}>
                        <DotIcon size={10} className="scale-250" />
                        {statusLabel(order.status)}
                    </div>
                    <div className={`text-center text-xs rounded-full px-2 py-1 ${payment.style}`}>
                        {payment.text}
                    </div>
                </td>
            </tr>
            <tr className="md:hidden">
                <td colSpan={5}>
                    <p>{order.address.name}, {order.address.street}</p>
                    <p>{order.address.city}, {order.address.state} {order.address.zip}, {order.address.country}</p>
                    <p>{order.address.phone}</p>
                    <br />
                    <div className="flex items-center justify-center gap-2">
                        <span className={`text-center px-4 py-1.5 rounded text-sm ${statusStyle(order.status)}`}>
                            {statusLabel(order.status)}
                        </span>
                        <span className={`text-center px-4 py-1.5 rounded text-sm ${payment.style}`}>
                            {payment.text}
                        </span>
                    </div>
                </td>
            </tr>
            <tr>
                <td colSpan={4}>
                    <div className="border-b border-slate-300 w-6/7 mx-auto" />
                </td>
            </tr>
        </>
    )
}

export default OrderItem