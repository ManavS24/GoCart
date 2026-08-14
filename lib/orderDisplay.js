// Presentation for OrderStatus and payment state. The badge used to compare
// against 'confirmed' and 'delivered', neither of which the enum contains, so
// every order rendered in the same neutral colour.

export const STATUS_LABELS = {
    ORDER_PLACED: 'Order placed',
    PROCESSING: 'Processing',
    SHIPPED: 'Shipped',
    DELIVERED: 'Delivered',
}

const STATUS_STYLES = {
    ORDER_PLACED: 'text-indigo-600 bg-indigo-100',
    PROCESSING: 'text-amber-600 bg-amber-100',
    SHIPPED: 'text-blue-600 bg-blue-100',
    DELIVERED: 'text-green-600 bg-green-100',
}

export const statusLabel = (status) =>
    STATUS_LABELS[status] ?? String(status ?? '').replace(/_/g, ' ')

export const statusStyle = (status) =>
    STATUS_STYLES[status] ?? 'text-slate-600 bg-slate-100'

// Cash on delivery is not "unpaid" in the sense that should worry a shopper;
// an online order awaiting confirmation is.
export const paymentLabel = ({ paymentMethod, isPaid }) => {
    if (paymentMethod === 'COD') return { text: 'Cash on delivery', style: 'text-slate-600 bg-slate-100' }
    if (isPaid) return { text: 'Paid online', style: 'text-green-600 bg-green-100' }
    return { text: 'Payment confirming', style: 'text-amber-600 bg-amber-100' }
}
