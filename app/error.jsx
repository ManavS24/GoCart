'use client'

// Catches a render error anywhere under app/ that no closer boundary handled.
// Without it Next.js replaces the page with a bare error screen.
export default function RouteError({ error, reset }) {
    return (
        <div className='min-h-[70vh] mx-6 flex flex-col items-center justify-center text-center'>
            <h1 className='text-2xl sm:text-3xl font-semibold text-slate-700'>Something went wrong</h1>
            <p className='mt-3 text-sm text-slate-500 max-w-md'>
                This page could not be displayed. The rest of the store is unaffected.
            </p>
            {error?.digest && (
                <p className='mt-2 text-xs text-slate-400'>Reference: {error.digest}</p>
            )}
            <button
                onClick={reset}
                className='mt-6 bg-slate-800 text-white px-8 py-2.5 text-sm rounded hover:bg-slate-900 active:scale-95 transition'
            >
                Try again
            </button>
        </div>
    )
}
