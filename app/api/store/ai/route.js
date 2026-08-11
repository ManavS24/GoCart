import { getOpenAI } from "@/configs/openai";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rateLimit";
import { MAX_IMAGE_BYTES, base64Bytes, bytesMatchClaimedType, isAllowedImageType } from "@/lib/uploadLimits";
import authSeller from "@/middlewares/authSeller";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";

async function main(base64Image, mimeType) {
    const messages = [
        {
            role: "system",
            content: `
                        You are a product listing assistant for an e-commerce store.
                        Your job is to analyze an image of a product and generate structured data.

                        Respond ONLY with raw JSON (no code block, no markdown, no explanation).
                        The JSON must strictly follow this schema:

                        {
                        "name": string,               // Short product name
                        "description": string,         // Marketing-friendly description of the product
                        }
                   `
        },
        {
            role: "user",
            content: [
                { type: "text", text: "Analyze this image and return name + description." },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
        },
    ];

    const response = await getOpenAI().chat.completions.create({
        model: process.env.OPENAI_MODEL,
        messages,
    });

    const raw = response.choices[0].message.content;

    const cleaned = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error("AI did not return valid JSON");
    }

    return parsed;

}


export async function POST(request) {
    try {
        const { userId } = getAuth(request)
        const storeId = await authSeller(userId);
        if (!storeId) {
            return NextResponse.json({ error: 'not authorized' }, { status: 401 })
        }
        // Every call is a paid request to a vision model.
        const limited = rateLimit({ key: `ai:${userId}`, limit: 10, windowMs: 60_000 })
        if (!limited.allowed) {
            logger.warn('rate_limited', { route: '/api/store/ai', userId })
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { base64Image, mimeType } = await request.json();

        if (!isAllowedImageType(mimeType)) {
            return NextResponse.json({ error: 'unsupported image type' }, { status: 400 });
        }

        // Before decoding: measuring by decoding allocates what the cap prevents.
        if (!base64Image || base64Bytes(base64Image) > MAX_IMAGE_BYTES) {
            return NextResponse.json({ error: 'image is too large' }, { status: 400 });
        }

        // Only the header: enough for the signature, harmless if hostile.
        const header = Buffer.from(String(base64Image).slice(0, 32), 'base64')
        if (!bytesMatchClaimedType(header, mimeType)) {
            return NextResponse.json({ error: 'that file is not the image type it claims to be' }, { status: 400 });
        }

        const result = await main(base64Image, mimeType);
        return NextResponse.json({ ...result });
    } catch (error) {
        return apiError(error, 500, request);
    }
}
