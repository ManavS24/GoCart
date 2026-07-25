# Demo guide

A three-minute walkthrough that shows all three roles without cuts. Rehearse
twice, record the third take.

## Before recording

Three Clerk accounts, created ahead of time and left signed in across three
browser profiles so no time is lost typing passwords:

| Account | Purpose | Setup |
| --- | --- | --- |
| `shopper@…` | Buying | Plain sign-up, nothing else |
| `seller@…` | Selling | Apply for a store, then approve it from the admin account |
| `admin@…` | Approving | Must be listed in `ADMIN_EMAIL` |

Checklist:

- [ ] `npm run seed` has run against the demo database
- [ ] The seeded **Nova Tech** store is still pending — it is what the admin approves on camera
- [ ] Coupon `NEW20` exists (the site banner advertises it; a failed coupon on camera is fatal)
- [ ] One product image saved locally, ready to drag in for the AI step
- [ ] Stripe is in **test** mode
- [ ] Load the site once beforehand — Neon auto-suspends when idle and the first request is slow
- [ ] Clean browser profile: no bookmarks bar, no extensions, zoom 110%

## Sequence

### 1 — Shopper (0:00–1:15)

1. Land on the storefront. Let the seeded catalogue speak for a beat.
2. Search for `headphones`. Filtering is instant.
3. Open a product. Point out ratings and that the seller is named — this is the
   multi-vendor part, worth saying out loud.
4. Add to cart. Open the cart.
5. Apply `NEW20`. The total updates.
6. Select an address, choose **Stripe**, pay with `4242 4242 4242 4242`, any
   future expiry, any CVC.
7. Land on the orders page showing the order as **Paid**.

> The Paid state arrives via a Stripe webhook, not the checkout request. Say so
> — it is the difference between a form that looks like checkout and one that is.

### 2 — Seller (1:15–2:15)

1. Switch to the seller profile. Open the dashboard: earnings, order count,
   product count, ratings.
2. **Add Product → upload an image.** The name and description auto-fill from a
   vision model. *This is the strongest moment in the demo — pause on it.*
3. Adjust the price, pick a category, save.
4. Open Manage Products, toggle stock off and on.
5. Open Orders, move an order to **SHIPPED**.

### 3 — Admin (2:15–3:00)

1. Switch to the admin profile. Approve **Nova Tech** from the approval queue.
2. Show Live Stores; toggle one inactive and back.
3. Create a coupon.
4. Close on the dashboard: platform revenue and the orders-per-day chart.

### Close (optional, 15s)

Cut to `npm test` — 176 tests green in under a second — and the architecture
diagram. Ties the product back to the engineering.

## Fallbacks

In order of preference. Never live-demo when a recording will do.

1. **The recording.** Immune to networks, cold starts and Stripe outages.
2. **Screenshots in the README** if video will not play.
3. **`npm run dev`** against a locally seeded database if the deployment is down.
4. **`npm test`** — always runs, no network, and still demonstrates rigour.

If a live demo stalls, narrate what should happen and move on. Do not debug on
camera.

## Recording

- 1080p, 30fps. OBS or QuickTime.
- **Record silent, add captions.** Portfolio and LinkedIn autoplay muted, and
  captions survive that; narration does not.
- Keep the cursor deliberate. Pause a beat after each click so a viewer can read
  the screen before it changes.
- Trim dead air. Three minutes is a ceiling, not a target.
- Host on YouTube unlisted, link from the README.

## Screenshots

Eight, into `docs/screenshots/`:

| File | Shot |
| --- | --- |
| `storefront.png` | Seeded catalogue — **this is the README hero** |
| `product.png` | Product detail with ratings |
| `cart.png` | Cart with `NEW20` applied |
| `checkout.png` | Stripe checkout |
| `orders.png` | Order history showing Paid |
| `seller-dashboard.png` | Earnings and ratings |
| `ai-autofill.png` | Mid-autofill, fields populating |
| `admin-approve.png` | Store approval queue |

Capture at a 1440px viewport for crisp README rendering.

## Talking points

Have these ready — they are what separates a walkthrough from an engineering
conversation.

- **Basket splits per seller.** One order per store, shipping charged once
  across the basket, each seller sees only their own line items.
- **Prices are never trusted from the client.** The request carries product ids
  and quantities; every unit price is re-read from the database.
- **Webhooks are idempotent.** Stripe retries, so each event id is claimed
  before any mutation; cancellation only ever deletes unpaid orders.
- **An authorization bug found by self-audit.** A helper returned `undefined`
  for non-approved stores, and Prisma silently drops `undefined` from a `where`
  clause — so the seller dashboard returned every order on the platform. Fixed
  at the root, and a test now asserts the helper can never return `undefined`.
- **Tests validated by mutation.** Each fixed defect was reintroduced to confirm
  the suite caught it. Passing tests prove nothing until you have watched them
  fail.
