'use client'

// The last resort: a failure in the root layout itself, where `app/error.jsx`
// has no layout left to render into. Supplies its own html and body.
export default function GlobalError({ error, reset }) {
    return (
        <html lang='en'>
            <body style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem 1.5rem', textAlign: 'center' }}>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Something went wrong</h1>
                <p style={{ marginTop: '0.75rem', color: '#64748b', fontSize: '0.875rem' }}>
                    The application could not start. Please try again.
                </p>
                {error?.digest && (
                    <p style={{ marginTop: '0.5rem', color: '#94a3b8', fontSize: '0.75rem' }}>
                        Reference: {error.digest}
                    </p>
                )}
                <button
                    onClick={reset}
                    style={{ marginTop: '1.5rem', background: '#1e293b', color: '#fff', border: 0, padding: '0.625rem 2rem', borderRadius: '0.25rem', fontSize: '0.875rem', cursor: 'pointer' }}
                >
                    Try again
                </button>
            </body>
        </html>
    )
}
