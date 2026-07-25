# GoCart

A multi-vendor e-commerce storefront built with Next.js 15 (App Router), Prisma
on Neon Postgres, Clerk for auth and billing, Stripe for payments, ImageKit for
media, and Inngest for background jobs.

## Architecture

Three surfaces share one Next.js app, separated by route group:

| Route             | Audience | Gate                                                            |
| ----------------- | -------- | --------------------------------------------------------------- |
| `app/(public)/*`  | Shoppers | Public; Clerk session enables cart, orders and checkout          |
| `app/store/*`     | Sellers  | `middlewares/authSeller` — user must own an **approved** store   |
| `app/admin/*`     | Admins   | `middlewares/authAdmin` — email must appear in `ADMIN_EMAIL`     |

API routes live under `app/api/*` and are the only place that touches the
database. Both auth helpers return a falsy value for every unauthorized case, so
each route guards with a single `if (!x) return 401`.

Client state is Redux Toolkit (`lib/store.js`), mounted by `app/StoreProvider.js`
and hydrated from the API by `app/(public)/layout.jsx`.

`inngest/functions.js` mirrors Clerk user create/update/delete into the `User`
table and schedules coupon deletion at expiry. It is served at `/api/inngest`.

## Getting started

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # then fill in real credentials
npx prisma migrate dev      # uses DIRECT_URL
npm run dev
```

The app is served at http://localhost:3000.

Every variable in `.env.example` is required except the `OPENAI_*` group, which
only powers AI-assisted product descriptions in `/api/store/ai`. Note that
`next build` prerenders pages wrapped in `<ClerkProvider>`, so it fails unless
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are real values.

## Scripts

| Script               | Purpose                                    |
| -------------------- | ------------------------------------------ |
| `npm run dev`        | Dev server (Turbopack)                     |
| `npm run build`      | `prisma generate` then a production build  |
| `npm start`          | Serve the production build                 |
| `npm run lint`       | ESLint via `next/core-web-vitals`          |
| `npm test`                 | Both suites (no database required)    |
| `npm run test:unit`        | Unit suite only                       |
| `npm run test:integration` | Integration suite only                |
| `npm run test:watch`       | Vitest in watch mode                  |

## Tests

There are exactly two entry points. Neither needs a database, network access or
credentials, so both run in CI as-is.

**`tests/unit_tests.test.js`** — every module in isolation, with Prisma, Clerk
and axios mocked: `safeInternalPath`, `authAdmin`, `authSeller`, all four Redux
slices, `makeStore`, and the `assets` module. Covers edge cases, invalid input
and failure modes.

**`tests/integration_tests.test.js`** — modules wired together. Only true
external boundaries are mocked (Prisma, Clerk, Stripe, ImageKit, OpenAI,
Inngest); the real `authAdmin`/`authSeller` middleware and the real route
handlers run unmodified. Covers the seller onboarding flow, checkout and
payment, webhook state transitions, the auth matrix across every endpoint,
configuration loading, and failure propagation.

Tests are written to find defects, not to inflate coverage. Comments name the
specific bug each case guards. The highest-value cases:

- `authSeller` never returns `undefined` — a non-approved store used to fall
  through to `undefined`, which Prisma dropped from `where: { storeId }`,
  exposing every order on the platform.
- Cart `total` stays equal to the sum of item quantities under randomised
  operation sequences — the removal path used to decrement the total even when
  the item was absent.
- Order pricing always comes from the database; quantities must be positive
  integers; addresses must belong to the buyer; coupons must be unexpired.
- Stripe webhook handling is idempotent and never deletes a paid order.

## Stripe webhook

`/api/stripe` verifies signatures with `STRIPE_WEBHOOK_SECRET` and handles
`payment_intent.succeeded` (mark orders paid, clear the cart) and
`payment_intent.canceled` (delete the pending, still-unpaid orders).

Handling is idempotent: each event id is inserted into `ProcessedWebhookEvent`
before any mutation, and a duplicate insert short-circuits the request. Stripe
retries deliveries, so without this a replayed `canceled` event would delete
orders a second time. **This model requires a migration** — run
`npx prisma migrate dev` (or `npx prisma db push`) before deploying.

Forward events locally with:

```bash
stripe listen --forward-to localhost:3000/api/stripe
```
