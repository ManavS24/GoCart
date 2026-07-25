import prisma from "@/lib/prisma"
import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

export async function POST(request){
    try {
        const body = await request.text()
        const sig = request.headers.get('stripe-signature')

        const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)

        // Claim the event id before any mutation: Stripe retries deliveries.
        try {
            await prisma.processedWebhookEvent.create({
                data: { id: event.id, type: event.type }
            })
        } catch (error) {
            if (error.code === 'P2002') {
                return NextResponse.json({ received: true, duplicate: true })
            }
            throw error
        }

        const handlePaymentIntent = async (paymentIntentId, isPaid) => {
            const session = await stripe.checkout.sessions.list({
                payment_intent: paymentIntentId
            })

            if(!session.data.length){
                console.warn('No checkout session for payment intent', paymentIntentId)
                return
            }

            const {orderIds, userId, appId} = session.data[0].metadata

            // Ignore sessions created by other apps sharing this Stripe account.
            if(appId !== 'gocart' || !orderIds){
                return
            }

            const orderIdsArray = orderIds.split(',')

            if(isPaid){
                await prisma.order.updateMany({
                    where: {id: {in: orderIdsArray}},
                    data: {isPaid: true}
                })
                await prisma.user.update({
                    where: {id: userId},
                    data: {cart : {}}
                })
            }else{
                 // Unpaid-only, so an out-of-order delivery cannot destroy a paid order.
                 await prisma.order.deleteMany({
                    where: {id: {in: orderIdsArray}, isPaid: false}
                 })
            }
        }

    
        switch (event.type) {
            case 'payment_intent.succeeded': {
                await handlePaymentIntent(event.data.object.id, true)
                break;
            }

            case 'payment_intent.canceled': {
                await handlePaymentIntent(event.data.object.id, false)
                break;
            }
        
            default:
                console.log('Unhandled event type:', event.type)
                break;
        }

        return NextResponse.json({received: true})
    } catch (error) {
        console.error(error)
        return NextResponse.json({ error: error.message }, { status: 400 })
    }
}
