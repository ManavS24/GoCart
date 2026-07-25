import prisma from "@/lib/prisma";
import { getAuth } from "@clerk/nextjs/server";
import { PaymentMethod } from "@prisma/client";
import { NextResponse } from "next/server";
import Stripe from "stripe";


export async function POST(request){
    try {
        const { userId, has } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: "not authorized" }, { status: 401 });
        }
        const { addressId, items, couponCode, paymentMethod } = await request.json()

        if(!addressId || !paymentMethod || !items || !Array.isArray(items) || items.length === 0){
           return NextResponse.json({ error: "missing order details." }, { status: 400 });
        }

        if(!Object.values(PaymentMethod).includes(paymentMethod)){
            return NextResponse.json({ error: "invalid payment method" }, { status: 400 });
        }

        // A negative quantity would subtract from the order total.
        for(const item of items){
            if(!item?.id || !Number.isInteger(item.quantity) || item.quantity < 1){
                return NextResponse.json({ error: "invalid order items" }, { status: 400 });
            }
        }

        // Scoped to userId so an order cannot be attached to a stranger's address.
        const address = await prisma.address.findFirst({
            where: { id: addressId, userId }
        })

        if(!address){
            return NextResponse.json({ error: "Address not found" }, { status: 400 })
        }

        let coupon = null;

        if (couponCode) {
            coupon = await prisma.coupon.findFirst({
                where: { code: couponCode, expiresAt: { gt: new Date() } }
            })
            if (!coupon){
                return NextResponse.json({ error: "Coupon not found" }, { status: 400 })
            }
        }

        if(couponCode && coupon.forNewUser){
            const userorders = await prisma.order.findMany({where: {userId}})
            if(userorders.length > 0){
                return NextResponse.json({ error: "Coupon valid for new users" }, { status: 400 })
            }
        }

        const isPlusMember = has({plan: 'plus'})

        if (couponCode && coupon.forMember){
            if(!isPlusMember){
                return NextResponse.json({ error: "Coupon valid for members only" }, { status: 400 })
            }
        }

         const ordersByStore = new Map()

         // Only products that are actually purchasable may be ordered.
         const products = await prisma.product.findMany({
            where: {
                id: { in: items.map(item => item.id) },
                inStock: true,
                store: { isActive: true, status: 'approved' }
            }
         })

         const productsById = new Map(products.map(product => [product.id, product]))

         for(const item of items){
            const product = productsById.get(item.id)
            if(!product){
                return NextResponse.json({ error: "product is unavailable" }, { status: 400 })
            }
            const storeId = product.storeId
            if(!ordersByStore.has(storeId)){
                ordersByStore.set(storeId, [])
            }
            ordersByStore.get(storeId).push({...item, price: product.price})
         }

         let orderIds = [];
         let fullAmount = 0;

         let isShippingFeeAdded = false

         for(const [storeId, sellerItems] of ordersByStore.entries()){
            let total = sellerItems.reduce((acc, item)=>acc + (item.price * item.quantity), 0)

            if(couponCode){
                total -= (total * coupon.discount) / 100;
            }
            if(!isPlusMember && !isShippingFeeAdded){
                total += 5;
                isShippingFeeAdded = true
            }

            fullAmount += parseFloat(total.toFixed(2))

            const order = await prisma.order.create({
                data: {
                    userId,
                     storeId,
                     addressId,
                     total: parseFloat(total.toFixed(2)),
                     paymentMethod,
                     isCouponUsed: coupon ? true : false,
                     coupon: coupon ? coupon : {},
                      orderItems: {
                        create: sellerItems.map(item => ({
                            productId: item.id,
                            quantity: item.quantity,
                            price: item.price
                        }))
                      }
                }
            })
            orderIds.push(order.id)
         }

         if(paymentMethod === 'STRIPE'){
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
            // The Origin header is absent on some clients.
            const origin = request.headers.get('origin') || request.nextUrl.origin

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data:{
                        currency: 'usd',
                        product_data:{
                            name: 'Order'
                        },
                        unit_amount: Math.round(fullAmount * 100)
                    },
                    quantity: 1
                }],
                expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
                mode: 'payment',
                success_url: `${origin}/loading?nextUrl=orders`,
                cancel_url: `${origin}/cart`,
                metadata: {
                    orderIds: orderIds.join(','),
                    userId,
                    appId: 'gocart'
                }
            })
            return NextResponse.json({session})
         }

          await prisma.user.update({
            where: {id: userId},
            data: {cart : {}}
          })

          return NextResponse.json({message: 'Orders Placed Successfully'})

    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: error.code || error.message }, { status: 400 })
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const orders = await prisma.order.findMany({
            where: {userId, OR: [
                {paymentMethod: PaymentMethod.COD},
                {AND: [{paymentMethod: PaymentMethod.STRIPE}, {isPaid: true}]}
            ]},
            include: {
                orderItems: {include: {product: true}},
                address: true
            },
            orderBy: {createdAt: 'desc'}
        })

        return NextResponse.json({orders})
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: error.message }, { status: 400 })
    }
}