import Link from 'next/link'

export const metadata = {
    title: 'About this project — GoCart',
    description: 'GoCart is an educational full-stack marketplace project. What it does, what is real, and what is simulated.',
}

const Section = ({ title, children }) => (
    <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
        <div className="mt-3 text-slate-600 text-sm leading-relaxed space-y-3">{children}</div>
    </section>
)

export default function AboutPage() {
    return (
        <div className="min-h-[70vh] mx-6">
            <div className="max-w-3xl mx-auto my-16">
                <h1 className="text-3xl font-semibold text-slate-800">About this project</h1>
                <p className="mt-4 text-slate-600 leading-relaxed">
                    GoCart is a multi-vendor marketplace built as an educational full-stack project. It is not a real
                    shop, not a registered business, and nothing on it is genuinely for sale.
                </p>

                <Section title="What is real">
                    <p>
                        The application itself works end to end. Accounts, stores, products, carts, coupons, orders and
                        reviews are stored in a real Postgres database and follow the same rules a live storefront would:
                        a store must be approved before its products appear, prices are computed on the server, a coupon
                        can only be used once per shopper, and an order counts only once it is placed or paid.
                    </p>
                    <p>
                        Payments go through Razorpay in test mode. The checkout, the payment page and the confirmation
                        are the real integration — only the money is not.
                    </p>
                </Section>

                <Section title="What is simulated">
                    <p>
                        The catalogue is seed data. The stores, their owners, the product listings and the customer
                        reviews were all written to populate the demo; none of them describes a real seller, a real
                        product or a real customer&apos;s opinion. Nothing ordered here will ever be shipped.
                    </p>
                </Section>

                <Section title="How it is built">
                    <p>
                        Next.js on the App Router, Prisma against Neon Postgres, Clerk for authentication, Razorpay for
                        payments, ImageKit for image hosting and Inngest for scheduled work. The source, including the
                        test suite, is public.
                    </p>
                </Section>

                <Section title="Contact">
                    <p>
                        Questions about the project are welcome at{' '}
                        <a href="mailto:manavsinglase27@gmail.com" className="text-green-600 hover:underline">manavsinglase27@gmail.com</a>,
                        or open an issue on{' '}
                        <a href="https://github.com/ManavS24/GoCart" target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline">GitHub</a>.
                    </p>
                </Section>

                <Link href="/shop" className="inline-block mt-12 bg-slate-800 text-white px-10 py-2.5 text-sm rounded hover:bg-slate-900 active:scale-95 transition">
                    Browse the catalogue
                </Link>
            </div>
        </div>
    )
}
