import Stripe from 'stripe'
import {inngest} from './client'
import { logger } from '@/lib/logger'
import prisma from '@/lib/prisma'

export const syncUserCreation = inngest.createFunction(
    {id: 'sync-user-create'},
    {event: 'clerk/user.created'},
    async ({ event }) => {
        const {data} = event
        await prisma.user.create({
            data: {
                id: data.id,
                email: data.email_addresses[0].email_address,
                name: `${data.first_name} ${data.last_name}`,
                image: data.image_url,
            }
        })
    }
)

export const syncUserUpdation = inngest.createFunction(
    {id: 'sync-user-update'},
    { event: 'clerk/user.updated' },
    async ({ event }) => {
        const { data } = event
        await prisma.user.update({
            where: {id: data.id,},
            data: {
                email: data.email_addresses[0].email_address,
                name: `${data.first_name} ${data.last_name}`,
                image: data.image_url,
            }
        })
    }
)

export const syncUserDeletion = inngest.createFunction(
    {id: 'sync-user-delete'},
    { event: 'clerk/user.deleted' },
    async ({ event }) => {
        const { data } = event
        await prisma.user.delete({
            where: {id: data.id,}
        })
    }
)

export const deleteCouponOnExpiry = inngest.createFunction(
    {id: 'delete-coupon-on-expiry'},
    { event: 'app/coupon.expired' },
    async ({ event, step }) => {
        const { data } = event
        const expiryDate = new Date(data.expires_at)
        await step.sleepUntil('wait-for-expiry', expiryDate)

        await step.run('delete-coupon-from-database', async () => {
            await prisma.coupon.delete({
                where: { code: data.code }
            })
        })
    }
)

// Wider than the run interval, so a missed run leaves no gap.
const RECONCILE_WINDOW_HOURS = 24

// Repairs payments Stripe took that this application never recorded. Nothing in
// the request path can detect that, because the request path is what failed.
export const reconcileStripePayments = inngest.createFunction(
    { id: 'reconcile-stripe-payments' },
    { cron: '15 * * * *' },
    async ({ step }) => {
        const since = Math.floor(Date.now() / 1000) - RECONCILE_WINDOW_HOURS * 3600

        const repaired = await step.run('repair-unconfirmed-payments', async () => {
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
            const results = []

            // Stripe is the authority on what was charged.
            for await (const intent of stripe.paymentIntents.list({ created: { gte: since }, limit: 100 })) {
                if (intent.status !== 'succeeded') continue

                const sessions = await stripe.checkout.sessions.list({ payment_intent: intent.id })
                const metadata = sessions.data[0]?.metadata
                if (!metadata || metadata.appId !== 'gocart' || !metadata.orderIds) continue

                const orderIds = metadata.orderIds.split(',')

                // Only unpaid rows change, so racing the webhook is harmless.
                const { count } = await prisma.order.updateMany({
                    where: { id: { in: orderIds }, isPaid: false },
                    data: { isPaid: true },
                })

                if (count > 0) {
                    await prisma.user.updateMany({ where: { id: metadata.userId }, data: { cart: {} } })
                    results.push({ paymentIntentId: intent.id, orderIds, count })
                }
            }

            return results
        })

        if (repaired.length > 0) {
            // Should never be routine: each is a payment the webhook missed.
            logger.error('payments_reconciled', {
                repairedCount: repaired.length,
                orders: repaired.flatMap(r => r.orderIds),
            })
        } else {
            logger.info('payments_reconciled', { repairedCount: 0 })
        }

        return { repaired: repaired.length }
    }
)

// Long enough to still recognise a late duplicate submission.
const CHECKOUT_KEY_RETENTION_DAYS = 30
const ABANDONED_ORDER_RETENTION_DAYS = 30

// Clears the debris the checkout flow leaves behind.
export const pruneCheckoutArtifacts = inngest.createFunction(
    { id: 'prune-checkout-artifacts' },
    { cron: '30 3 * * *' },
    async ({ step }) => {
        const cutoff = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

        const keys = await step.run('prune-checkout-requests', async () => {
            const { count } = await prisma.checkoutRequest.deleteMany({
                where: { createdAt: { lt: cutoff(CHECKOUT_KEY_RETENTION_DAYS) } },
            })
            return count
        })

        const orders = await step.run('prune-abandoned-checkouts', async () => {
            // Only rows far older than the reconciliation window, so a payment
            // still awaiting repair is never destroyed.
            const { count } = await prisma.order.deleteMany({
                where: {
                    paymentMethod: 'STRIPE',
                    isPaid: false,
                    createdAt: { lt: cutoff(ABANDONED_ORDER_RETENTION_DAYS) },
                },
            })
            return count
        })

        logger.info('checkout_artifacts_pruned', { checkoutRequests: keys, abandonedOrders: orders })
        return { checkoutRequests: keys, abandonedOrders: orders }
    }
)
