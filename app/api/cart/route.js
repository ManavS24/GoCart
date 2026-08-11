import { bodyTooLarge, parseCartInput } from "@/lib/cartInput";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { ensureUser } from "@/lib/ensureUser";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function POST(request){
    try {
        const { userId } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }
        // The Clerk -> Inngest sync is asynchronous; this write cannot wait for it.
        await ensureUser(userId)

        if(bodyTooLarge(request)){
            return NextResponse.json({ error: 'cart is too large' }, { status: 413 })
        }

        const body = await request.json()
        const { cart, error } = parseCartInput(body?.cart)

        if(error){
            return NextResponse.json({ error }, { status: 400 })
        }

        // Dropped rather than rejected: a product can vanish from under a
        // shopper, and refusing the write would stop their cart saving at all.
        const ids = Object.keys(cart)
        const known = ids.length
            ? await prisma.product.findMany({
                where: { id: { in: ids } },
                select: { id: true },
            })
            : []

        const knownIds = new Set(known.map(product => product.id))
        const persisted = Object.fromEntries(
            Object.entries(cart).filter(([productId]) => knownIds.has(productId))
        )

        if(ids.length !== Object.keys(persisted).length){
            logger.warn('cart_unknown_products_dropped', {
                userId, sent: ids.length, kept: Object.keys(persisted).length,
            })
        }

        await prisma.user.update({
            where: {id: userId},
            data: {cart: persisted}
        })

        return NextResponse.json({ message: 'Cart updated' })
    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        const user = await prisma.user.findUnique({
            where: {id: userId}
        })

        // The Clerk -> Inngest sync creates the user row asynchronously.
        return NextResponse.json({ cart: user?.cart ?? {} })
    } catch (error) {
        return apiError(error, 500, request)
    }
}