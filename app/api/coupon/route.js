import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function POST(request){
    try {
        const {userId, has} = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: "not authorized" }, { status: 401 })
        }

        const limited = rateLimit({ key: `coupon:${userId}`, limit: 20, windowMs: 60_000 })
        if (!limited.allowed) {
            logger.warn('rate_limited', { route: '/api/coupon', userId })
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { code } = await request.json()

        if(!code || typeof code !== 'string'){
            return NextResponse.json({ error: "Coupon not found" }, { status: 404 })
        }

        const coupon = await prisma.coupon.findFirst({
            where: {
                code: code.toUpperCase(),
                expiresAt: {gt: new Date()}
            }
        })

        if (!coupon){
            return NextResponse.json({ error: "Coupon not found" }, { status: 404 })
        }

        if(coupon.forNewUser){
            const userorders = await prisma.order.findMany({where: {userId}})
            if(userorders.length > 0){
                return NextResponse.json({ error: "Coupon valid for new users" }, { status: 400 })
            }
        }

        if (coupon.forMember){
            const hasPlusPlan = has({plan: 'plus'})
            if(!hasPlusPlan){
                return NextResponse.json({ error: "Coupon valid for members only" }, { status: 400 })
            }
        }

        return NextResponse.json({coupon})
    } catch (error) {
        return apiError(error, 500, request)
    }
}