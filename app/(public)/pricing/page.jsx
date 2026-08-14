import { PricingTable } from '@clerk/nextjs'
import ErrorBoundary from '@/components/ErrorBoundary'

// Clerk's PricingTable throws outright when billing is not enabled on the
// instance, which is the default. Without a boundary that took the whole page
// down for every visitor.
export default function PricingPage() {
    return (
        <div className='mx-auto max-w-[700px] my-28 px-6'>
            <ErrorBoundary
                name='pricing-table'
                fallback={
                    <div className='text-center text-slate-500'>
                        <h1 className='text-2xl font-semibold text-slate-700'>Plans are not available yet</h1>
                        <p className='mt-3 text-sm'>
                            Membership is still being set up. Everything else in the store works as normal.
                        </p>
                    </div>
                }
            >
                <PricingTable />
            </ErrorBoundary>
        </div>
    )
}
