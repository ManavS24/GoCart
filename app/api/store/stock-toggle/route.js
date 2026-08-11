import prisma from "@/lib/prisma";
import authSeller from "@/middlewares/authSeller";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

export async function POST(request){
    try {
        // Authenticate before reading the body: an anonymous caller should learn
        // nothing about which fields the endpoint wants.
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if (!storeId) {
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        const { productId } = await request.json()

        if(!productId){
            return NextResponse.json({ error: "missing details: productId" }, { status: 400 });
        }

        const product = await prisma.product.findFirst({
             where: {id: productId, storeId}
        })

        if(!product){
            return NextResponse.json({ error: 'no product found' }, { status: 404 })
        }

        await prisma.product.update({
            where: { id: productId },
            data: {inStock: !product.inStock}
        })

        return NextResponse.json({message: "Product stock updated successfully"})
    } catch (error) {
        return apiError(error, 500, request)
    }
}