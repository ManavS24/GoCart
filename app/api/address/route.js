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

        const { address } = await request.json()

        if(!address || typeof address !== 'object'){
            return NextResponse.json({ error: 'missing address' }, { status: 400 })
        }

        // Allowlisted so a caller cannot pin the row id or another user's id.
        const newAddress = await prisma.address.create({
            data: {
                userId,
                name: address.name,
                email: address.email,
                street: address.street,
                city: address.city,
                state: address.state,
                zip: address.zip,
                country: address.country,
                phone: address.phone,
            }
        })

        return NextResponse.json({newAddress, message: 'Address added successfully' })
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

        const addresses = await prisma.address.findMany({
            where: { userId }
        })

        return NextResponse.json({addresses})
    } catch (error) {
        return apiError(error, 500, request)
    }
}