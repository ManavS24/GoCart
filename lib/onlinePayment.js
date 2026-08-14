// Methods paid before fulfilment, as opposed to COD. A provider is added here
// and every rule that distinguishes "pay now" from "pay later" follows.
//
// Plain strings rather than Prisma's PaymentMethod enum: this module is
// imported by a client component, and @prisma/client cannot go to the browser.
// A test asserts these against the schema so the two cannot drift.
export const ONLINE_PAYMENT_METHODS = ['STRIPE', 'RAZORPAY']

export const isOnlineMethod = (method) => ONLINE_PAYMENT_METHODS.includes(method)

// The provider currently wired up. STRIPE remains in the enum for rows written
// before the switch; nothing creates one.
export const ACTIVE_ONLINE_METHOD = 'RAZORPAY'
