import { logger } from "@/lib/logger"
import prisma from "@/lib/prisma"
import { NextResponse } from "next/server"
import { apiError } from "@/lib/apiError";
import { verifyWebhookSignature } from "@/lib/razorpaySignature"

// Claims the event id and reports whether this delivery should do the work.
// Only a *completed* claim suppresses redelivery: an incomplete one is the
// debris of a failed delivery, and both mutations below are idempotent.
const claimEvent = async (eventId, type) => {
    try {
        await prisma.processedWebhookEvent.create({
            data: { id: eventId, type }
        })
        return true
    } catch (error) {
        if (error.code !== 'P2002') throw error

        const existing = await prisma.processedWebhookEvent.findUnique({
            where: { id: eventId }
        })
        return !existing?.completedAt
    }
}

// Razorpay's own id when it sends one, otherwise derived from the entity so a
// redelivery still collides with its first attempt in the ledger.
const eventIdFor = (request, event) => {
    const header = request.headers.get('x-razorpay-event-id')
    if (header) return header

    const entityId = event?.payload?.payment_link?.entity?.id
    return entityId ? `${event.event}:${entityId}` : null
}

export async function POST(request){
    // Its own block, so an unverifiable payload stays a 400 rather than a 500.
    let event
    let eventId
    try {
        // The raw text, not the parsed object: the signature covers the exact
        // bytes sent, which re-serialising would not reproduce.
        const body = await request.text()
        const signature = request.headers.get('x-razorpay-signature')

        if (!verifyWebhookSignature(body, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
            throw new Error('razorpay webhook signature verification failed')
        }

        event = JSON.parse(body)
        eventId = eventIdFor(request, event)
        if (!eventId) throw new Error('razorpay webhook carried no identifiable event')
    } catch (error) {
        return apiError(error, 400)
    }

    try {
        if (!(await claimEvent(eventId, event.event))) {
            // Alertable: a spike means events are being replayed.
            logger.info('webhook_duplicate', { eventId, type: event.event })
            return NextResponse.json({ received: true, duplicate: true })
        }

        // Carried on the payload itself, so confirming a payment needs no
        // round trip back to Razorpay.
        const resolveOrders = (entity) => {
            const { orderIds, userId, appId } = entity?.notes ?? {}

            // Ignore links created by other apps sharing this Razorpay account.
            if (appId !== 'gocart' || !orderIds) return null

            return { orderIds: orderIds.split(','), userId }
        }

        let target = null
        let isPaid = false

        switch (event.event) {
            case 'payment_link.paid': {
                isPaid = true
                target = resolveOrders(event.payload?.payment_link?.entity)
                break;
            }

            case 'payment_link.cancelled':
            case 'payment_link.expired': {
                target = resolveOrders(event.payload?.payment_link?.entity)
                break;
            }

            default:
                logger.info('webhook_ignored', { eventId, type: event.event })
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
                where: { id: eventId },
                data: { completedAt: new Date() }
            })
        })

        // Counted against Razorpay's own captured-payment total to reconcile.
        logger.info('webhook_processed', {
            eventId,
            type: event.event,
            orderIds: target?.orderIds ?? [],
            markedPaid: Boolean(target && isPaid),
        })

        return NextResponse.json({received: true})
    } catch (error) {
        return apiError(error, 500, request)
    }
}
