import { PLACED_ORDER } from "@/lib/placedOrder";
import prisma from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";
import { ensureUser } from "@/lib/ensureUser";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function POST(request){
    try {
        const { userId } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }
        // The Clerk -> Inngest sync is asynchronous; this write cannot wait for it.
        await ensureUser(userId)

        const {orderId, productId, rating, review} = await request.json()

        if(!Number.isInteger(rating) || rating < 1 || rating > 5){
            return NextResponse.json({ error: "rating must be between 1 and 5" }, { status: 400 })
        }

        // Matched on line item, else any buyer could rate any product, and on
        // delivery, else a review says nothing about it.
        const order = await prisma.order.findFirst({
            where: {
                id: orderId,
                userId,
                orderItems: { some: { productId } },
                status: OrderStatus.DELIVERED,
                ...PLACED_ORDER,
            }
        })

        if(!order){
            return NextResponse.json(
                { error: "You can review a product once its order has been delivered" },
                { status: 404 }
            )
        }

         const isAlreadyRated = await prisma.rating.findFirst({where: {productId, orderId}})

         if(isAlreadyRated){
            return NextResponse.json({ error: "Product already rated" }, { status: 400 })
         }

         const response = await prisma.rating.create({
            data: {userId, productId, rating, review, orderId}
         })

         return NextResponse.json({message: "Rating added successfully", rating: response})

      
    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const {userId} = getAuth(request)
        if(!userId){
            return NextResponse.json({error: "Unauthorized"}, { status: 401 })
        }
        const ratings = await prisma.rating.findMany({
            where: {userId}
        })

        return NextResponse.json({ratings})
    } catch (error) {
        return apiError(error, 500, request)
    }
}