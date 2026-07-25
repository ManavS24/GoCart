'use client'

import Loading from "@/components/Loading"
import { safeInternalPath } from "@/lib/safeInternalPath"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

export default function LoadingPage() {
    const router = useRouter()

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        // `nextUrl` is attacker-controllable.
        const target = safeInternalPath(params.get('nextUrl'))

        if (!target) return

        const timer = setTimeout(() => router.push(target), 8000)

        return () => clearTimeout(timer)
    }, [router])

    return <Loading />
}
