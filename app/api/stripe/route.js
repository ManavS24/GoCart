import { logger } from "@/lib/logger"
import prisma from "@/lib/prisma"
import { NextResponse } from "next/server"
import { apiError } from "@/lib/apiError";
import Stripe from "stripe"

// Claims the event id and reports whether this delivery should do the work.
// Only a *completed* claim suppresses redelivery: an incomplete one is the
// debris of a failed delivery, and both mutations below are idempotent.
const claimEvent = async (event) => {
    try {
        await prisma.processedWebhookEvent.create({
            data: { id: event.id, type: event.type }
        })
        return true
    } catch (error) {
        if (error.code !== 'P2002') throw error

        const existing = await prisma.processedWebhookEvent.findUnique({
            where: { id: event.id }
        })
        return !existing?.completedAt
    }
}

export async function POST(request){
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

    // Its own block, so an unverifiable payload stays a 400 rather than a 500.
    let event
    try {
        const body = await request.text()
        const sig = request.headers.get('stripe-signature')
        event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (error) {
        return apiError(error, 400)
    }

    try {
        if (!(await claimEvent(event))) {
            // Alertable: a spike means events are being replayed.
            logger.info('webhook_duplicate', { eventId: event.id, type: event.type })
            return NextResponse.json({ received: true, duplicate: true })
        }

        // Before the transaction opens: holding one across an external round
        // trip pins a connection and risks the transaction timeout.
        const resolveOrders = async (paymentIntentId) => {
            const session = await stripe.checkout.sessions.list({
                payment_intent: paymentIntentId
            })

            if(!session.data.length){
                // Retryable, not terminal: a session not yet visible is
                // indistinguishable from one that never existed.
                logger.warn('webhook_session_missing', { eventId: event.id, paymentIntentId })
                throw new Error(`no checkout session for payment intent ${paymentIntentId}`)
            }

            const {orderIds, userId, appId} = session.data[0].metadata

            // Ignore sessions created by other apps sharing this Stripe account.
            if(appId !== 'gocart' || !orderIds){
                return null
            }

            return { orderIds: orderIds.split(','), userId }
        }

        let target = null
        let isPaid = false

        switch (event.type) {
            case 'payment_intent.succeeded': {
                isPaid = true
                target = await resolveOrders(event.data.object.id)
                break;
            }

            case 'payment_intent.canceled': {
                target = await resolveOrders(event.data.object.id)
                break;
            }

            default:
                logger.info('webhook_ignored', { eventId: event.id, type: event.type })
                break;
        }

        // Mutations and the completion mark commit together, so a failure
        // leaves the claim incomplete and the retry reruns it.
        await prisma.$transaction(async (tx) => {
            if (target && isPaid) {
                await tx.order.updateMany({
                    where: {id: {in: target.orderIds}},
                    data: {isPaid: true}
                })
                // updateMany: a missing user row must not roll back the
                // payment confirmation for the sake of clearing a cart.
                await tx.user.updateMany({
                    where: {id: target.userId},
                    data: {cart : {}}
                })
            } else if (target) {
                // Unpaid-only, so an out-of-order delivery cannot destroy a paid order.
                await tx.order.deleteMany({
                    where: {id: {in: target.orderIds}, isPaid: false}
                })
            }

            await tx.processedWebhookEvent.update({
                where: { id: event.id },
                data: { completedAt: new Date() }
            })
        })

        // Counted against Stripe's own succeeded-payment total to reconcile.
        logger.info('webhook_processed', {
            eventId: event.id,
            type: event.type,
            orderIds: target?.orderIds ?? [],
            markedPaid: Boolean(target && isPaid),
        })

        return NextResponse.json({received: true})
    } catch (error) {
        return apiError(error, 500, request)
    }
}
