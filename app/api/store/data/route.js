import { SELLABLE_STORE } from "@/lib/sellableStore";
import prisma from "@/lib/prisma";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

export async function GET(request){
    try {
        // Budgeted by address, and generously: this blunts scraping, not traffic.
        const limited = rateLimit({ key: `store-page:${callerIp(request)}`, limit: 120, windowMs: 60_000 })
        if (!limited.allowed) {
            return NextResponse.json(
                { error: 'Too many requests.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { searchParams } = new URL(request.url)
        const usernameParam = searchParams.get('username')

        if(!usernameParam){
            return NextResponse.json({error: "missing username"}, { status: 400 })
        }

        const username = usernameParam.toLowerCase();

        const store = await prisma.store.findUnique({
            where: {username, ...SELLABLE_STORE},
            select: {
                // `email` is deliberately public -- it is the store's own
                // contact address -- but the owner id and phone are not.
                id: true, name: true, description: true, address: true,
                email: true, logo: true, username: true,
                Product: {
                    include: {
                        // Whole Rating rows carry the reviewer's id and order.
                        rating: { select: { rating: true } },
                    },
                },
            },
        })

        if(!store){
            return NextResponse.json({error: "store not found"}, { status: 400 })
        }

        return NextResponse.json({store})
    } catch (error) {
        return apiError(error, 500, request)
    }
}