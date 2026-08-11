import prisma from "@/lib/prisma";
import { PLACED_ORDER } from "@/lib/placedOrder";
import authSeller from "@/middlewares/authSeller";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if(!storeId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        // Earnings and the order count must mean the same thing as the order
        // list: an abandoned Stripe checkout is not revenue.
        const orders = await prisma.order.findMany({where: {storeId, ...PLACED_ORDER}})

         const products = await prisma.product.findMany({where: {storeId}})

         const ratings = await prisma.rating.findMany({
            where: {productId: {in: products.map(product => product.id)}},
            include: {
                user: { select: { name: true, image: true } },
                product: { select: { id: true, name: true, category: true } },
            }
         })

         const dashboardData = {
            ratings,
            totalOrders: orders.length,
            totalEarnings: Math.round(orders.reduce((acc, order)=>  acc + order.total, 0)),
            totalProducts: products.length
         }

         return NextResponse.json({ dashboardData });
    } catch (error) {
        return apiError(error, 500, request)
    }
}