import { logger } from "@/lib/logger";
import { parseOrderStatus } from "@/lib/orderStatus";
import prisma from "@/lib/prisma";
import { PLACED_ORDER } from "@/lib/placedOrder";
import authSeller from "@/middlewares/authSeller";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function POST(request){
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if(!storeId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        const {orderId, status } = await request.json()

        // Required before updateMany: Prisma drops an undefined key from a
        // where clause, which would update every order in the store.
        if(!orderId || typeof orderId !== 'string'){
            return NextResponse.json({ error: "missing details: orderId" }, { status: 400 })
        }

        const { status: nextStatus, reachableFrom, error } = parseOrderStatus(status)

        if(error){
            return NextResponse.json({ error }, { status: 400 })
        }

        // Both guards live in the update's `where`, so there is no window
        // between checking and writing. The read is in the same transaction, so
        // the history records what the order actually moved from.
        const { count, previous } = await prisma.$transaction(async (tx) => {
            const before = await tx.order.findFirst({
                where: { id: orderId, storeId, ...PLACED_ORDER, status: { in: reachableFrom } },
                select: { status: true },
            })

            if (!before) return { count: 0, previous: null }

            const { count } = await tx.order.updateMany({
                where: {
                    id: orderId,
                    storeId,
                    ...PLACED_ORDER,
                    status: { in: reachableFrom },
                },
                data: { status: nextStatus }
            })

            if (count > 0 && before.status !== nextStatus) {
                await tx.orderStatusChange.create({
                    data: { orderId, storeId, from: before.status, to: nextStatus },
                })
            }

            return { count, previous: before.status }
        })

        if(!count){
            // On the failure path only, to say which of the two reasons it was.
            const existing = await prisma.order.findFirst({
                where: { id: orderId, storeId, ...PLACED_ORDER },
                select: { status: true },
            })

            if(existing){
                return NextResponse.json(
                    { error: `an order cannot move from ${existing.status} back to ${nextStatus}` },
                    { status: 409 }
                )
            }

            return NextResponse.json({ error: "no order found" }, { status: 404 })
        }

        // The row keeps only the latest value.
        logger.info('order_status_changed', { orderId, storeId, from: previous, status: nextStatus })

        return NextResponse.json({message: "Order Status updated"})
    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if(!storeId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        const orders = await prisma.order.findMany({
            where: {storeId, ...PLACED_ORDER},
            include: {
                // What the fulfilment screen shows. The full row would also
                // carry the buyer's id and their live shopping cart.
                user: { select: { name: true, email: true } },
                address: true,
                orderItems: {include: {product: true}},
            },
            orderBy: {createdAt: 'desc' }
        })

        return NextResponse.json({orders})
    } catch (error) {
        return apiError(error, 500, request)
    }
}