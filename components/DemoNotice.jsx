import Link from 'next/link'

// The catalogue, stores, reviews and orders are seeded. Saying so is the
// difference between a demo and something pretending to be a shop.
const DemoNotice = () => (
    <div className="bg-slate-800 text-slate-200 text-xs sm:text-sm">
        <p className="max-w-7xl mx-auto px-6 py-2 text-center">
            Educational project — not a real marketplace. Stores, products, reviews and orders are sample data, and
            payments run in Razorpay test mode, so nothing is really bought, sold or charged.{' '}
            <Link href="/about" className="underline underline-offset-2 hover:text-white">About this project</Link>
        </p>
    </div>
)

export default DemoNotice
