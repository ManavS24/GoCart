import { apiError } from "@/lib/apiError";
import prisma from "@/lib/prisma";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { NextResponse } from "next/server";

const MAX_EMAIL_LENGTH = 254
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/

// Public by design: subscribing must not require an account.
export async function POST(request) {
    try {
        const limited = rateLimit({ key: `newsletter:${callerIp(request)}`, limit: 5, windowMs: 60_000 })
        if (!limited.allowed) {
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment and try again.' },
                { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
            )
        }

        const { email } = await request.json()

        // Normalised before validating: an address pasted with a trailing space
        // is a valid address, and casing is not part of the identity.
        const address = typeof email === 'string' ? email.trim().toLowerCase() : ''

        if (!address || address.length > MAX_EMAIL_LENGTH || !EMAIL.test(address)) {
            return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
        }

        await prisma.newsletterSubscriber.upsert({
            where: { email: address },
            update: {},
            create: { email: address },
        })

        return NextResponse.json({ message: 'Subscribed' })
    } catch (error) {
        return apiError(error, 500, request)
    }
}
