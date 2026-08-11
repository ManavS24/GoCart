// Money is counted in whole cents: float arithmetic on currency drifts, and
// order totals are built by multiplying, discounting and summing.

// A stored price -> whole cents. Rounds, so a value that drifted lands right.
export const toCents = (amount) => {
    const cents = Math.round(Number(amount) * 100)
    return Number.isFinite(cents) ? cents : 0
}

export const fromCents = (cents) => Math.round(cents) / 100

export const sumCents = (values) => values.reduce((total, value) => total + value, 0)

// Rounded once, where the percentage is applied, rather than left to accumulate.
export const percentOfCents = (cents, percent) => {
    const applied = Math.round((cents * Number(percent)) / 100)
    return Number.isFinite(applied) ? applied : 0
}

export const SHIPPING_CENTS = 500
