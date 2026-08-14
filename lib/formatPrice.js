// Digit grouping for display only. Prices are stored and charged as numbers;
// this never feeds back into arithmetic.
export const formatAmount = (amount) => {
    const value = Number(amount)
    if (!Number.isFinite(value)) return '0'

    return value.toLocaleString('en-IN', {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
    })
}

export default formatAmount
