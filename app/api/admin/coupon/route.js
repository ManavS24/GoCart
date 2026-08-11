import { inngest } from "@/inngest/client";
import { parseCouponInput } from "@/lib/couponInput";
import prisma from "@/lib/prisma";
import authAdmin from "@/middlewares/authAdmin";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function POST(request){
    try {
        const { userId } = getAuth(request)
        const isAdmin = await authAdmin(userId)

        if (!isAdmin) {
            return NextResponse.json({ error: "not authorized" }, { status: 401 })
        }

        const body = await request.json()
        const { coupon, error } = parseCouponInput(body?.coupon)

        if (error) {
            return NextResponse.json({ error }, { status: 400 })
        }

        await prisma.coupon.create({data: coupon}).then(async (coupon) => {
            await inngest.send({
                name: "app/coupon.expired",
                data: {
                    code: coupon.code,
                    expires_at: coupon.expiresAt,
                }
            })
        })

        return NextResponse.json({message: "Coupon added successfully"})

    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function DELETE(request){
    try {
        const { userId } = getAuth(request)
        const isAdmin = await authAdmin(userId)

        if (!isAdmin) {
            return NextResponse.json({ error: "not authorized" }, { status: 401 })
        }

        const { searchParams } = request.nextUrl;
        const code = searchParams.get('code')

        await prisma.coupon.delete({where: { code }})
        return NextResponse.json({ message: 'Coupon deleted successfully' })
    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const isAdmin = await authAdmin(userId)

        if (!isAdmin) {
            return NextResponse.json({ error: "not authorized" }, { status: 401 })
        }
        const coupons = await prisma.coupon.findMany({})
        return NextResponse.json({ coupons })
    } catch (error) {
        return apiError(error, 500, request)
    }
}