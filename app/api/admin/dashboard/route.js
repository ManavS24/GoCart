import prisma from "@/lib/prisma";
import { fromCents, toCents } from "@/lib/money";
import { PLACED_ORDER } from "@/lib/placedOrder";
import authAdmin from "@/middlewares/authAdmin";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

// How much history the orders-per-day chart shows.
const CHART_WINDOW_DAYS = 30;


export async function GET(request){

    try {
        const { userId } = getAuth(request)
    const isAdmin = await authAdmin(userId)

     if (!isAdmin) {
            return NextResponse.json({ error: 'not authorized' }, { status: 401 });
        }

    // Two numbers rather than every order row: summing in Node meant the whole
    // table travelled to the application to produce one figure.
    const totals = await prisma.order.aggregate({
        where: PLACED_ORDER,
        _sum: { total: true },
        _count: true,
    })

    const stores = await prisma.store.count()

    // One row per order, but not the whole history and not the amounts.
    const chartWindowStart = new Date(Date.now() - CHART_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const allOrders = await prisma.order.findMany({
        where: { ...PLACED_ORDER, createdAt: { gte: chartWindowStart } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
    })

    const orders = totals._count
    const revenue = fromCents(toCents(totals._sum.total ?? 0)).toFixed(2)
     const products = await prisma.product.count()
    const dashboardData = {
        orders,
        stores,
        products,
        revenue,
        allOrders
    }

    return NextResponse.json({dashboardData})

    } catch (error) {
         return apiError(error, 500, request)
    }
    

}