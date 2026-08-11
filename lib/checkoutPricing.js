import { SHIPPING_CENTS, percentOfCents, sumCents, toCents } from '@/lib/money'

// What a basket costs. One definition, used by the server to charge and by the
// cart summary to display, so the two cannot disagree by a rounded cent.
// Shipping is charged once per basket, not once per seller.
export const priceBasket = ({ items, discountPercent = 0, chargeShipping = true }) => {
    const byStore = new Map()
    for (const item of items) {
        const forStore = byStore.get(item.storeId) ?? []
        forStore.push(item)
        byStore.set(item.storeId, forStore)
    }

    let shippingApplied = false
    const stores = []

    for (const [storeId, storeItems] of byStore) {
        let cents = sumCents(storeItems.map(item => toCents(item.price) * item.quantity))

        if (discountPercent) {
            // A stored coupon can still be out of range, so the floor is here.
            cents = Math.max(0, cents - percentOfCents(cents, discountPercent))
        }

        if (chargeShipping && !shippingApplied) {
            cents += SHIPPING_CENTS
            shippingApplied = true
        }

        stores.push({ storeId, items: storeItems, cents })
    }

    return { stores, totalCents: sumCents(stores.map(store => store.cents)) }
}

export default priceBasket
