import getImageKit from "@/configs/imageKit"
import { logger } from "@/lib/logger"
import prisma from "@/lib/prisma"
import { rateLimit } from "@/lib/rateLimit"
import { MAX_IMAGES_PER_PRODUCT, MAX_IMAGE_BYTES, bytesMatchClaimedType, isAllowedImageType } from "@/lib/uploadLimits"
import authSeller from "@/middlewares/authSeller"
import {getAuth} from "@clerk/nextjs/server"
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

export async function POST(request){
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if(!storeId){
            return NextResponse.json({error: 'not authorized'}, { status: 401 } )
        }
        const limited = rateLimit({ key: `product:${userId}`, limit: 30, windowMs: 60_000 })
        if (!limited.allowed) {
            logger.warn('rate_limited', { route: '/api/store/product', userId })
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const formData = await request.formData()
        const name = formData.get("name")
        const description = formData.get("description")
        const mrp =  Number(formData.get("mrp"))
        const price = Number(formData.get("price"))
        const category = formData.get("category")
        const images = formData.getAll("images")

        if(!name || !description || !mrp || !price || !category || images.length < 1){
            return NextResponse.json({error: 'missing product details'}, { status: 400 } )
        }

        if(images.length > MAX_IMAGES_PER_PRODUCT){
            return NextResponse.json(
                {error: `a product may have at most ${MAX_IMAGES_PER_PRODUCT} images`},
                { status: 400 }
            )
        }

        // Checked before any upload starts, and buffered once so the bytes
        // checked are the bytes uploaded.
        const buffers = []
        for(const image of images){
            if(!isAllowedImageType(image?.type)){
                return NextResponse.json({error: 'unsupported image type'}, { status: 400 })
            }
            if(image.size > MAX_IMAGE_BYTES){
                return NextResponse.json({error: 'image is too large'}, { status: 400 })
            }
            const buffer = Buffer.from(await image.arrayBuffer())
            // `size` and `type` are both client-supplied; the bytes are not.
            if(buffer.length > MAX_IMAGE_BYTES){
                return NextResponse.json({error: 'image is too large'}, { status: 400 })
            }
            if(!bytesMatchClaimedType(buffer, image.type)){
                return NextResponse.json({error: 'that file is not the image type it claims to be'}, { status: 400 })
            }
            buffers.push({ buffer, name: image.name })
        }

        // These values flow straight into order totals.
        if(!Number.isFinite(mrp) || !Number.isFinite(price) || mrp <= 0 || price <= 0 || price > mrp){
            return NextResponse.json({error: 'invalid product price'}, { status: 400 } )
        }

        const imagekit = getImageKit()
        const imagesUrl = await Promise.all(buffers.map(async ({ buffer, name }) => {
            const response = await imagekit.upload({
                file: buffer,
                fileName: name,
                folder: "products",
            })
            const url = imagekit.url({
                path: response.filePath,
                transformation: [
                    { quality: 'auto' },
                    { format: 'webp' },
                    { width: '1024' }
                ]
            })
            return url
        }))

        await prisma.product.create({
             data: {
                name,
                description,
                mrp,
                price,
                category,
                images: imagesUrl,
                storeId
             }
        })

         return NextResponse.json({message: "Product added successfully"})

    } catch (error) {
        return apiError(error, 500, request)
    }
}

export async function GET(request){
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId)

        if(!storeId){
            return NextResponse.json({error: 'not authorized'}, { status: 401 } )
        }
        const products = await prisma.product.findMany({ where: { storeId }})

        return NextResponse.json({products})
    } catch (error) {
        return apiError(error, 500, request)
    }
}