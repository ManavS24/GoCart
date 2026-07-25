'use client'
import { useUser, UserButton } from "@clerk/nextjs"
import Link from "next/link"

const DashboardNavbar = ({ href, badge, badgeOffsetClass }) => {

    const { user } = useUser()

    return (
        <div className="flex items-center justify-between px-12 py-3 border-b border-slate-200 transition-all">
            <Link href={href} className="relative text-4xl font-semibold text-slate-700">
                <span className="text-green-600">go</span>cart<span className="text-green-600 text-5xl leading-0">.</span>
                <p className={`absolute text-xs font-semibold -top-1 ${badgeOffsetClass} px-3 p-0.5 rounded-full flex items-center gap-2 text-white bg-green-500`}>
                    {badge}
                </p>
            </Link>
            <div className="flex items-center gap-3">
                <p>Hi, {user?.firstName}</p>
                <UserButton />
            </div>
        </div>
    )
}

export default DashboardNavbar
