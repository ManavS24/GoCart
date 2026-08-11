import prisma from "@/lib/prisma";
import authAdmin from "@/middlewares/authAdmin";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const isAdmin = await authAdmin(userId)

        if (!isAdmin) {
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        const stores = await prisma.store.findMany({
            where: { status: 'approved' },
            // StoreInfo renders the applicant's name, email and avatar. The
            // full row would also hand the admin console their cart.
            include: { user: { select: { name: true, email: true, image: true } } }
        })

        return NextResponse.json({ stores })

    } catch (error) {
        return apiError(error, 500, request)
    }
}