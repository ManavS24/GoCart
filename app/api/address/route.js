import prisma from "@/lib/prisma";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function POST(request){
    try {
        const { userId } = getAuth(request)
        if(!userId){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }
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
        console.error(error);
        return NextResponse.json({ error: error.code || error.message }, { status: 400 })
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
        console.error(error);
        return NextResponse.json({ error: error.code || error.message }, { status: 400 })
    }
}