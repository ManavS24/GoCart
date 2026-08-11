import { apiError } from "@/lib/apiError";
import prisma from "@/lib/prisma";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { SELLABLE_STORE } from "@/lib/sellableStore";
import { NextResponse } from "next/server";

// The catalogue is a page, not the whole table: returning every product with
// every review grows linearly with both, and the client needs neither.
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100
// A basket can hold this many, so an id lookup never needs paging.
const MAX_IDS = 100

const parseLimit = (value) => {
    const limit = Number(value)
    if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT
    return Math.min(limit, MAX_LIMIT)
}

// A count and an average, not every review: the cards need only these, and the
// full list is on the product page, which is where it is read.
const summarise = ({ rating, ...product }) => ({
    ...product,
    ratingCount: rating.length,
    ratingAverage: rating.length
        ? Math.round((rating.reduce((total, r) => total + r.rating, 0) / rating.length) * 10) / 10
        : 0,
})

export async function GET(request){
    try {
        // Budgeted by address, and generously: this blunts scraping, not traffic.
        const limited = rateLimit({ key: `catalogue:${callerIp(request)}`, limit: 120, windowMs: 60_000 })
        if (!limited.allowed) {
            return NextResponse.json(
                { error: 'Too many requests.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { searchParams } = new URL(request.url)
        const ids = searchParams.get('ids')
        const search = searchParams.get('search')?.trim()
        const cursor = searchParams.get('cursor')
        const limit = parseLimit(searchParams.get('limit'))

        const where = {
            inStock: true,
            store: SELLABLE_STORE,
            // On the server, so a match on page nine is still findable.
            ...(search ? {
                OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { category: { contains: search, mode: 'insensitive' } },
                ],
            } : {}),
        }

        // What the cart needs to price items no longer on the current page.
        if (ids) {
            const wanted = ids.split(',').map(id => id.trim()).filter(Boolean).slice(0, MAX_IDS)
            if (!wanted.length) return NextResponse.json({ products: [], nextCursor: null })

            const products = await prisma.product.findMany({
                where: { ...where, id: { in: wanted } },
                include: { rating: { select: { rating: true } }, store: { select: { name: true, username: true, logo: true } } },
            })
            return NextResponse.json({ products: products.map(summarise), nextCursor: null })
        }

        // One row beyond the page, so "is there more" needs no second query.
        const products = await prisma.product.findMany({
            where,
            include: {
                rating: { select: { rating: true } },
                store: { select: { name: true, username: true, logo: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        })

        const hasMore = products.length > limit
        const page = hasMore ? products.slice(0, limit) : products

        return NextResponse.json({
            products: page.map(summarise),
            nextCursor: hasMore ? page[page.length - 1].id : null,
        })
    } catch (error) {
        return apiError(error, 500, request)
    }
}
