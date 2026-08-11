import { describeError, logger } from "@/lib/logger"
import { priceBasket } from "@/lib/checkoutPricing"
import { fromCents } from "@/lib/money"
import { SELLABLE_STORE } from "@/lib/sellableStore";
import prisma from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { ensureUser } from "@/lib/ensureUser";
import { PLACED_ORDER } from "@/lib/placedOrder";
import { getAuth } from "@clerk/nextjs/server";
import { PaymentMethod } from "@prisma/client";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import Stripe from "stripe";


// What a repeated submission gets back: the original outcome, never a second one.
const replayCheckout = (previous) => {
    if (previous.sessionUrl) {
        return NextResponse.json({ session: { url: previous.sessionUrl } })
    }
    if (previous.paymentMethod === PaymentMethod.COD) {
        return NextResponse.json({ message: 'Orders Placed Successfully' })
    }
    // Its session is still being created by the request that got here first.
    return NextResponse.json(
        { error: 'This checkout is already being processed.' },
        { status: 409 }
    )
}

export async function POST(request){
    try {
        const { userId, has } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: "not authorized" }, { status: 401 });
        }
        // The Clerk -> Inngest sync is asynchronous; this write cannot wait for it.
        await ensureUser(userId)

        const limited = rateLimit({ key: `orders:${userId}`, limit: 20, windowMs: 60_000 })
        if (!limited.allowed) {
            logger.warn('rate_limited', { route: '/api/orders', userId })
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        // Identifies the submission, not the click: a double-click, a retry and
        // a second tab all arrive carrying the same value.
        const idempotencyKey = request.headers.get('idempotency-key') || null

        if (idempotencyKey) {
            const previous = await prisma.checkoutRequest.findUnique({
                where: { key: idempotencyKey },
            })
            // Honouring another account's key would hand them its outcome.
            if (previous && previous.userId !== userId) {
                return NextResponse.json({ error: 'Invalid checkout key.' }, { status: 409 })
            }
            if (previous) return replayCheckout(previous)
        }

        const { addressId, items, couponCode, paymentMethod } = await request.json()

        if(!addressId || !paymentMethod || !items || !Array.isArray(items) || items.length === 0){
           return NextResponse.json({ error: "missing order details." }, { status: 400 });
        }

        if(!Object.values(PaymentMethod).includes(paymentMethod)){
            return NextResponse.json({ error: "invalid payment method" }, { status: 400 });
        }

        // Never start a payment that cannot be confirmed: without the secret
        // /api/stripe rejects every delivery and the charge is never recorded.
        if(paymentMethod === PaymentMethod.STRIPE && !process.env.STRIPE_WEBHOOK_SECRET){
            logger.error('card_checkout_refused', { reason: 'STRIPE_WEBHOOK_SECRET is not set' })
            return NextResponse.json(
                { error: "Card payment is temporarily unavailable. Please choose cash on delivery." },
                { status: 503 }
            );
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
            // Placed orders only: an abandoned checkout must not make a
            // genuinely new shopper ineligible.
            const userorders = await prisma.order.findMany({where: {userId, ...PLACED_ORDER}})
            if(userorders.length > 0){
                return NextResponse.json({ error: "Coupon valid for new users" }, { status: 400 })
            }
        }

        if(couponCode){
            // Derived from orders that stand, so an abandoned checkout never
            // burns the shopper's coupon.
            const alreadyUsed = await prisma.order.findFirst({
                where: { userId, couponCode: coupon.code, ...PLACED_ORDER },
                select: { id: true },
            })

            if(alreadyUsed){
                return NextResponse.json({ error: "You have already used this coupon" }, { status: 400 })
            }

            if(coupon.maxRedemptions !== null && coupon.maxRedemptions !== undefined){
                const timesUsed = await prisma.order.count({
                    where: { couponCode: coupon.code, ...PLACED_ORDER },
                })

                if(timesUsed >= coupon.maxRedemptions){
                    return NextResponse.json(
                        { error: "This coupon is no longer available" },
                        { status: 400 }
                    )
                }
            }
        }

        const isPlusMember = has({plan: 'plus'})

        if (couponCode && coupon.forMember){
            if(!isPlusMember){
                return NextResponse.json({ error: "Coupon valid for members only" }, { status: 400 })
            }
        }

         // Only products that are actually purchasable may be ordered.
         const products = await prisma.product.findMany({
            where: {
                id: { in: items.map(item => item.id) },
                inStock: true,
                store: SELLABLE_STORE
            }
         })

         const productsById = new Map(products.map(product => [product.id, product]))
         const pricedItems = []

         for(const item of items){
            const product = productsById.get(item.id)
            if(!product){
                return NextResponse.json({ error: "product is unavailable" }, { status: 400 })
            }
            // Price from the database, never from the request.
            pricedItems.push({...item, storeId: product.storeId, price: product.price})
         }

         // The same function the cart summary displays from, so shown and
         // charged cannot diverge. Computed before the transaction opens.
         const { stores: perStore, totalCents: fullAmountCents } = priceBasket({
            items: pricedItems,
            discountPercent: couponCode ? coupon.discount : 0,
            chargeShipping: !isPlusMember,
         })

         // One basket is one unit of work: independent writes left a failure
         // on the second seller with the first order committed.
         const orderIds = await prisma.$transaction(async (tx) => {
            const ids = []
            for(const { storeId, items: sellerItems, cents } of perStore){
                const order = await tx.order.create({
                    data: {
                        userId,
                         storeId,
                         addressId,
                         total: fromCents(cents),
                         paymentMethod,
                         isCouponUsed: coupon ? true : false,
                         couponCode: coupon ? coupon.code : null,
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
                ids.push(order.id)
            }

            // Claimed with the orders it describes, so a key never points at a
            // rolled-back basket and a concurrent duplicate rolls back with it.
            if(idempotencyKey){
                await tx.checkoutRequest.create({
                    data: { key: idempotencyKey, userId, orderIds: ids, paymentMethod },
                })
            }

            // COD is complete on commit. updateMany cannot fail on a missing row.
            if(paymentMethod !== 'STRIPE'){
                await tx.user.updateMany({
                    where: {id: userId},
                    data: {cart : {}}
                })
            }

            return ids
         }).catch(async (error) => {
            // Two submissions raced past the pre-check; the loser rolled back,
            // so return what the winner produced rather than an error.
            if(idempotencyKey && error.code === 'P2002'){
                const winner = await prisma.checkoutRequest.findUnique({
                    where: { key: idempotencyKey },
                })
                if(winner) return { replay: replayCheckout(winner) }
            }
            throw error
         })

         if(orderIds.replay) return orderIds.replay

         // Stripe rejects a zero-amount session, so a basket that costs nothing
         // is settled here rather than sent to a payment page.
         if(paymentMethod === 'STRIPE' && fullAmountCents === 0){
            await prisma.order.updateMany({
                where: { id: { in: orderIds } },
                data: { isPaid: true },
            })
            await prisma.user.updateMany({ where: {id: userId}, data: {cart: {}} })
            logger.info('zero_total_order_settled', { userId, orderIds })
            return NextResponse.json({ message: 'Orders Placed Successfully' })
         }

         if(paymentMethod === 'STRIPE'){
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
            // The Origin header is absent on some clients.
            const origin = request.headers.get('origin') || request.nextUrl.origin

            // Outside the transaction: holding a connection across an external
            // round trip exhausts the pool. Undone below if it fails.
            let session
            try {
                session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data:{
                            currency: 'usd',
                            product_data:{
                                name: 'Order'
                            },
                            unit_amount: fullAmountCents
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
            } catch (error) {
                // Unpaid-only, so a payment that landed meanwhile survives.
                await prisma.order.deleteMany({
                    where: { id: { in: orderIds }, isPaid: false }
                }).catch(cleanupError => logger.error('order_cleanup_failed', describeError(cleanupError)))
                // Released with them, or the retry replays deleted orders.
                if(idempotencyKey){
                    await prisma.checkoutRequest.delete({
                        where: { key: idempotencyKey },
                    }).catch(cleanupError => logger.error('checkout_key_cleanup_failed', describeError(cleanupError)))
                }
                throw error
            }

            if(idempotencyKey){
                await prisma.checkoutRequest.update({
                    where: { key: idempotencyKey },
                    data: { sessionUrl: session.url },
                })
            }

            return NextResponse.json({session})
         }

          return NextResponse.json({message: 'Orders Placed Successfully'})

    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: "not authorized" }, { status: 401 });
        }
        const orders = await prisma.order.findMany({
            where: {userId, ...PLACED_ORDER},
            include: {
                orderItems: {include: {product: true}},
                address: true
            },
            orderBy: {createdAt: 'desc'}
        })

        return NextResponse.json({orders})
    } catch (error) {
        return apiError(error, 500, request)
    }
}