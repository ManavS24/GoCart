import Razorpay from 'razorpay'
import {inngest} from './client'
import { logger } from '@/lib/logger'
import prisma from '@/lib/prisma'
import { ONLINE_PAYMENT_METHODS } from '@/lib/onlinePayment'

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

// Razorpay returns at most this many links per call.
const RECONCILE_PAGE_SIZE = 100

// Repairs payments Razorpay took that this application never recorded. Nothing
// in the request path can detect that, because the request path is what failed.
export const reconcileRazorpayPayments = inngest.createFunction(
    { id: 'reconcile-razorpay-payments' },
    { cron: '15 * * * *' },
    async ({ step }) => {
        const since = Math.floor(Date.now() / 1000) - RECONCILE_WINDOW_HOURS * 3600

        const repaired = await step.run('repair-unconfirmed-payments', async () => {
            const razorpay = new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID,
                key_secret: process.env.RAZORPAY_KEY_SECRET,
            })
            const results = []

            // Razorpay is the authority on what was charged.
            for (let skip = 0; ; skip += RECONCILE_PAGE_SIZE) {
                const page = await razorpay.paymentLink.all({
                    from: since,
                    count: RECONCILE_PAGE_SIZE,
                    skip,
                })
                const links = page?.payment_links ?? []

                for (const link of links) {
                    if (link.status !== 'paid') continue

                    const notes = link.notes
                    if (!notes || notes.appId !== 'gocart' || !notes.orderIds) continue

                    const orderIds = notes.orderIds.split(',')

                    // Only unpaid rows change, so racing the webhook is harmless.
                    const { count } = await prisma.order.updateMany({
                        where: { id: { in: orderIds }, isPaid: false },
                        data: { isPaid: true },
                    })

                    if (count > 0) {
                        await prisma.user.updateMany({ where: { id: notes.userId }, data: { cart: {} } })
                        results.push({ paymentLinkId: link.id, orderIds, count })
                    }
                }

                if (links.length < RECONCILE_PAGE_SIZE) break
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
                    paymentMethod: { in: ONLINE_PAYMENT_METHODS },
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
