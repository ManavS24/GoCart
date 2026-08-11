import { apiError } from "@/lib/apiError";
import { SELLABLE_STORE } from "@/lib/sellableStore";
import prisma from "@/lib/prisma";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { NextResponse } from "next/server";

// One product, by id, so the page renders without waiting for the whole
// catalogue and can tell "missing" from "not loaded yet".
export async function GET(request, { params }) {
    try {
        // Budgeted by address, and generously: this blunts scraping, not traffic.
        const limited = rateLimit({ key: `product-page:${callerIp(request)}`, limit: 120, windowMs: 60_000 })
        if (!limited.allowed) {
            return NextResponse.json(
                { error: 'Too many requests.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { productId } = await params

        const product = await prisma.product.findFirst({
            where: {
                id: productId,
                inStock: true,
                store: SELLABLE_STORE,
            },
            include: {
                rating: {
                    select: {
                        createdAt: true, rating: true, review: true,
                        user: { select: { name: true, image: true } },
                    },
                },
                // The full row carries the seller's contact details and id.
                store: { select: { name: true, username: true, logo: true } },
            },
        })

        if (!product) {
            return NextResponse.json({ error: "Product not found" }, { status: 404 })
        }

        return NextResponse.json({ product })
    } catch (error) {
        return apiError(error, 500, request)
    }
}
