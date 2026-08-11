import authAdmin from "@/middlewares/authAdmin";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";


export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const isAdmin = await authAdmin(userId)

        if(!isAdmin){
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }

        return NextResponse.json({isAdmin})
    } catch (error) {
        return apiError(error, 500, request)
    }
}