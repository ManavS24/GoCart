import getImageKit from "@/configs/imageKit";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { MAX_IMAGE_BYTES, isAllowedImageType } from "@/lib/uploadLimits";
import { rateLimit } from "@/lib/rateLimit";
import { ensureUser } from "@/lib/ensureUser";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

export async function POST(request){
    try {
        const {userId} = getAuth(request)
        if(!userId){
            return NextResponse.json({error: "not authorized"}, {status: 401})
        }
        // The Clerk -> Inngest sync is asynchronous; this write cannot wait for it.
        await ensureUser(userId)

        const limited = rateLimit({ key: `store-create:${userId}`, limit: 5, windowMs: 60_000 })
        if (!limited.allowed) {
            logger.warn('rate_limited', { route: '/api/store/create', userId })
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const formData = await request.formData()

        const name = formData.get("name")
        // Read before trimming: formData.get returns null for a missing field.
        const username = (formData.get("username") || "").toString().trim()
        const description = formData.get("description")
        const email = formData.get("email")
        const contact = formData.get("contact")
        const address = formData.get("address")
        const image = formData.get("image")

        if(!name || !username || !description || !email || !contact || !address || !image){
            return NextResponse.json({error: "missing store info"}, {status: 400})
        }

        if(!isAllowedImageType(image?.type)){
            return NextResponse.json({error: "unsupported image type"}, {status: 400})
        }

        if(image.size > MAX_IMAGE_BYTES){
            return NextResponse.json({error: "logo is too large"}, {status: 400})
        }

        const store = await prisma.store.findFirst({
            where: { userId: userId}
        })

        if(store){
            return NextResponse.json({status: store.status})
        }

        const isUsernameTaken = await prisma.store.findFirst({
            where: { username: username.toLowerCase() }
        })

        if(isUsernameTaken){
            return NextResponse.json({error: "username already taken"}, {status: 400})
        }

        const imagekit = getImageKit()
        const buffer = Buffer.from(await image.arrayBuffer());
        const response = await imagekit.upload({
            file: buffer,
            fileName: image.name,
            folder: "logos"
        })

        const optimizedImage = imagekit.url({
            path: response.filePath,
            transformation: [
                {quality: 'auto'},
                { format: 'webp' },
                { width: '512' }
            ]
        })

        const newStore = await prisma.store.create({
            data: {
                userId,
                name,
                description,
                username: username.toLowerCase(),
                email,
                contact,
                address,
                logo: optimizedImage
            }
        })

        await prisma.user.update({
            where: { id: userId },
            data: {store: {connect: {id: newStore.id}}}
        })

        return NextResponse.json({message: "applied, waiting for approval"})

    } catch (error) {
        return apiError(error, 500, request)
    }
}


export async function GET(request) {
    try {
        const {userId} = getAuth(request)
        if(!userId){
            return NextResponse.json({error: "not authorized"}, {status: 401})
        }

        const store = await prisma.store.findFirst({
            where: { userId: userId}
        })

        if(store){
            return NextResponse.json({status: store.status})
        }

        return NextResponse.json({status: "not registered"})
    } catch (error) {
        return apiError(error, 500, request)
    }
}