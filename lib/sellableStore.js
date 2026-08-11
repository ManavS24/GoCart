// Both conditions matter: `status` is the administrator's decision, `isActive`
// whether the store is switched on. Checking one alone let rejected stores sell.
export const SELLABLE_STORE = {
    isActive: true,
    status: 'approved',
}

export default SELLABLE_STORE
