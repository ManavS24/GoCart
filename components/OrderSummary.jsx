import { formatAmount } from '@/lib/formatPrice'
import { PlusIcon, SquarePenIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react'
import AddressModal from './AddressModal';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import {Protect, useAuth, useUser} from '@clerk/nextjs'
import axios from 'axios';
import { fetchCart } from '@/lib/features/cart/cartSlice';
import { priceBasket } from '@/lib/checkoutPricing';
import { isOnlineMethod } from '@/lib/onlinePayment';
import { fromCents, sumCents, toCents } from '@/lib/money';

const OrderSummary = ({ totalPrice, items }) => {

    const {user} = useUser()
    const { getToken } = useAuth()
    const dispatch = useDispatch()
    const currency = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '$';

    const router = useRouter();

    const addressList = useSelector(state => state.address.list);

    const [paymentMethod, setPaymentMethod] = useState('COD');
    const [selectedAddress, setSelectedAddress] = useState(null);
    const [showAddressModal, setShowAddressModal] = useState(false);
    const [couponCodeInput, setCouponCodeInput] = useState('');
    const [coupon, setCoupon] = useState('');
    const [placing, setPlacing] = useState(false);

    // The same function the server prices with. Shipping is shown separately.
    const discountPercent = coupon ? coupon.discount : 0;
    const subtotalCents = sumCents(items.map(item => toCents(item.price) * item.quantity));
    const { totalCents: discountedCents } = priceBasket({
        items, discountPercent, chargeShipping: false,
    });
    const discountCents = subtotalCents - discountedCents;

    // Identifies the submission, not the click, so a double-click sends the same
    // key twice. Rotated only after one succeeds.
    const idempotencyKey = useRef(crypto.randomUUID());

    const handleCouponCode = async (event) => {
        event.preventDefault();
        try {
            if(!user){
                return toast('Please login to proceed')
            }
            const token = await getToken();
            const { data } = await axios.post('/api/coupon', {code: couponCodeInput}, {
                headers: { Authorization: `Bearer ${token}` }
            })
            setCoupon(data.coupon)
            toast.success('Coupon Applied')
        } catch (error) {
            toast.error(error?.response?.data?.error || error.message)
        }
        
    }

    const handlePlaceOrder = async (e) => {
        e.preventDefault();
        // Does nothing for a second tab, which is why the server dedupes too.
        if(placing) return
        try {
            if(!user){
                return toast('Please login to place an order')
            }
            if(!selectedAddress){
                return toast('Please select an address')
            }
            setPlacing(true)
            const token = await getToken();

            const orderData = {
                addressId: selectedAddress.id,
                items,
                paymentMethod
            }

            if(coupon){
                orderData.couponCode = coupon.code
            }
           const {data} = await axios.post('/api/orders', orderData, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Idempotency-Key': idempotencyKey.current,
            }
           })

           // Spent: the next basket is a new submission.
           idempotencyKey.current = crypto.randomUUID()

           if(isOnlineMethod(paymentMethod)){
            window.location.href = data.session.url;
            return
           }
           toast.success(data.message)
           router.push('/orders')
           dispatch(fetchCart({getToken}))

        } catch (error) {
            toast.error(error?.response?.data?.error || error.message)
        } finally {
            setPlacing(false)
        }

        
    }

    return (
        <div className='w-full max-w-lg lg:max-w-[340px] bg-slate-50/30 border border-slate-200 text-slate-500 text-sm rounded-xl p-7'>
            <h2 className='text-xl font-medium text-slate-600'>Payment Summary</h2>
            <p className='text-slate-400 text-xs my-4'>Payment Method</p>
            <div className='flex gap-2 items-center'>
                <input type="radio" id="COD" onChange={() => setPaymentMethod('COD')} checked={paymentMethod === 'COD'} className='accent-gray-500' />
                <label htmlFor="COD" className='cursor-pointer'>COD</label>
            </div>
            <div className='flex gap-2 items-center mt-1'>
                <input type="radio" id="RAZORPAY" name='payment' onChange={() => setPaymentMethod('RAZORPAY')} checked={paymentMethod === 'RAZORPAY'} className='accent-gray-500' />
                <label htmlFor="RAZORPAY" className='cursor-pointer'>Pay Online</label>
            </div>
            <div className='my-4 py-4 border-y border-slate-200 text-slate-400'>
                <p>Address</p>
                {
                    selectedAddress ? (
                        <div className='flex gap-2 items-center'>
                            <p>{selectedAddress.name}, {selectedAddress.city}, {selectedAddress.state}, {selectedAddress.zip}</p>
                            <SquarePenIcon onClick={() => setSelectedAddress(null)} className='cursor-pointer' size={18} />
                        </div>
                    ) : (
                        <div>
                            {
                                addressList.length > 0 && (
                                    <select className='border border-slate-400 p-2 w-full my-3 outline-none rounded' onChange={(e) => setSelectedAddress(addressList[e.target.value])} >
                                        <option value="">Select Address</option>
                                        {
                                            addressList.map((address, index) => (
                                                <option key={index} value={index}>{address.name}, {address.city}, {address.state}, {address.zip}</option>
                                            ))
                                        }
                                    </select>
                                )
                            }
                            <button className='flex items-center gap-1 text-slate-600 mt-1' onClick={() => setShowAddressModal(true)} >Add Address <PlusIcon size={18} /></button>
                        </div>
                    )
                }
            </div>
            <div className='pb-4 border-b border-slate-200'>
                <div className='flex justify-between'>
                    <div className='flex flex-col gap-1 text-slate-400'>
                        <p>Subtotal:</p>
                        <p>Shipping:</p>
                        {coupon && <p>Coupon:</p>}
                    </div>
                    <div className='flex flex-col gap-1 font-medium text-right'>
                        <p>{currency}{formatAmount(totalPrice)}</p>
                        <p><Protect plan={'plus'} fallback={`${currency}5`}>Free</Protect></p>
                        {coupon && <p>{`-${currency}${formatAmount(fromCents(discountCents))}`}</p>}
                    </div>
                </div>
                {
                    !coupon ? (
                        <form onSubmit={e => toast.promise(handleCouponCode(e), { loading: 'Checking Coupon...' })} className='flex justify-center gap-3 mt-3'>
                            <input onChange={(e) => setCouponCodeInput(e.target.value)} value={couponCodeInput} type="text" placeholder='Coupon Code' className='border border-slate-400 p-1.5 rounded w-full outline-none' />
                            <button className='bg-slate-600 text-white px-3 rounded hover:bg-slate-800 active:scale-95 transition-all'>Apply</button>
                        </form>
                    ) : (
                        <div className='w-full flex items-center justify-center gap-2 text-xs mt-2'>
                            <p>Code: <span className='font-semibold ml-1'>{coupon.code.toUpperCase()}</span></p>
                            <p>{coupon.description}</p>
                            <XIcon size={18} onClick={() => setCoupon('')} className='hover:text-red-700 transition cursor-pointer' />
                        </div>
                    )
                }
            </div>
            <div className='flex justify-between py-4'>
                <p>Total:</p>
                <p className='font-medium text-right'>
                    <Protect plan={'plus'} fallback={`${currency}${fromCents(priceBasket({ items, discountPercent, chargeShipping: true }).totalCents).toFixed(2)}`}>
                    {currency}{formatAmount(fromCents(discountedCents))}
                    </Protect>
                    </p>
            </div>
            <button onClick={e => toast.promise(handlePlaceOrder(e), { loading: 'placing Order...' })} disabled={placing} className='w-full bg-slate-700 text-white py-2.5 rounded hover:bg-slate-900 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100'>{placing ? 'Placing Order...' : 'Place Order'}</button>

            {showAddressModal && <AddressModal setShowAddressModal={setShowAddressModal} />}

        </div>
    )
}

export default OrderSummary