# GoCart

[![CI](https://github.com/ManavS24/GoCart/actions/workflows/ci.yml/badge.svg)](https://github.com/ManavS24/GoCart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-vendor e-commerce marketplace where independent sellers list products in
a shared storefront, a single basket can span several sellers, and an
administrator approves who goes live.

Built with Next.js 15 (App Router), Prisma on Neon Postgres, Clerk, Razorpay,
ImageKit and Inngest.

> **This is an educational project, not a real marketplace.** The catalogue,
> stores, reviews and orders are seed data, and payments run in Razorpay test
> mode, so nothing is really bought, sold or charged. The application itself is
> real and works end to end — the running app says the same thing to visitors,
> in a standing notice and on its `/about` page.

## Features

**Shoppers** — browse and search a multi-seller catalogue, server-persisted
cart, coupon validation, online or cash-on-delivery checkout, order history with
payment state, product ratings gated on an actual delivered purchase.

**Sellers** — apply for a store, await approval, then manage products with
ImageKit uploads, toggle stock, advance order status, and view earnings.
Uploading a product image can auto-fill its name and description via an
OpenAI-compatible vision model.

**Admins** — approve or reject store applications, activate and deactivate
live stores, issue coupons with new-user and members-only rules, and see
platform-wide revenue with an orders-per-day chart.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19 |
| Styling | Tailwind CSS 4 |
| Database | Neon Postgres via Prisma 6 — 9 migrations |
| Auth | Clerk |
| Payments | Razorpay payment links, confirmed by a scheduled sweep |
| Media | ImageKit |
| Background jobs | Inngest |
| Client state | Redux Toolkit |
| Tests | Vitest — 512 tests, no database or network required |
| Hosting | Vercel |

## Quickstart

Requires Node 22 (`.nvmrc`), which is enforced: `.npmrc` sets `engine-strict`,
so `npm install` refuses to run on anything else. You will also need free
accounts with [Neon](https://neon.tech), [Clerk](https://clerk.com),
[Razorpay](https://razorpay.com), [ImageKit](https://imagekit.io) and
[Inngest](https://inngest.com).

```bash
nvm use                   # Node 22
npm install
cp .env.example .env      # fill in credentials
npm run check             # validates every variable, then pings the database
npm run migrate:deploy    # creates the schema
npm run seed              # 2 live stores, 1 pending, 16 products, coupons, ratings
npm run dev
```

Then open http://localhost:3000.

Two things that will otherwise cost you time:

- **`ADMIN_EMAIL` must be the email you sign up with**, and that address must be
  verified and primary in Clerk. Otherwise `/admin` stays locked and you cannot
  approve your own seller store.
- **Online payment is confirmed by polling, not by a webhook.** There is no
  webhook endpoint and no webhook secret: a scheduled sweep asks Razorpay every
  five minutes which payment links were paid, and marks the matching orders. A
  shopper can therefore be charged up to five minutes before the order shows as
  paid — and the API keys alone are enough to take payments, including on
  localhost with no public URL.

`npm run check` reports exactly which variables are missing or malformed and
whether the database is reachable, so a bad credential fails there rather than
deep inside Next, Prisma or Clerk.

### Optional

Clerk **billing** is not enabled by default. Without it, `/pricing` shows a
"plans are not available yet" message and the Plus benefits (free shipping,
members-only coupons) stay inert. Everything else works.

The three `OPENAI_*` variables are optional and only power AI product-description
autofill.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) |
| `npm run check` | Validate `.env` and database connectivity |
| `npm run seed` | Populate the demo catalogue (idempotent — safe to re-run) |
| `npm run build` | `prisma generate` → `next build`. **Does not touch the database.** |
| `npm run migrate:deploy` | Apply pending migrations |
| `npm run migrate:status` | Show which migrations are applied and which are pending |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | All three suites |
| `npm run test:unit` | Unit suite only |
| `npm run test:integration` | Integration suite only |

## Deploying the demo

Deploys to Vercel from `main`; Neon holds the data. Nothing is self-hosted, and
the whole stack fits in free tiers.

1. Import the repository in Vercel.
2. Add every variable from `.env.example` **before the first build** — pages
   wrapped in `<ClerkProvider>` are prerendered, and the build fails on a
   malformed Clerk key.
3. Apply migrations, then deploy. The build does not touch the database.
4. Nothing to configure at Razorpay: payments are confirmed by the scheduled
   sweep using the same API keys as checkout. Online orders are refused with a
   503 whenever those keys are absent, rather than taking a payment the app
   cannot confirm.
5. In Inngest, sync the app at `https://<your-app>/api/inngest`, and confirm all
   six functions register.
6. Seed once: `npm run seed`.

### Migrations

Migrations are **not** part of the build, so a deploy cannot ship a schema
change while the previous version is still serving. Apply them first:

```bash
npm run migrate:status   # what is pending
npm run migrate:deploy   # apply it
```

That order is safe because migrations are **additive**: a new column is
nullable, a new table unreferenced, nothing dropped or narrowed — so the old
code keeps working against the new schema. A test enforces this. A migration
containing `DROP COLUMN`, `DROP TABLE`, a rename, or an `ALTER COLUMN` that
narrows a type or adds `NOT NULL` fails the suite unless it carries an explicit
`-- expand-contract:` note explaining the plan.

To roll back, redeploy the previous commit; the schema can stay where it is.
There are no down migrations — take a Neon branch before migrating if you want
a restore point.

## Testing

Three suites, none requiring a database, network access or credentials.

**`tests/unit_tests.test.js`** — modules in isolation with Prisma, Clerk and
axios mocked: authorization helpers, all four Redux slices, money arithmetic,
basket pricing, order status and display, input parsing, and structural guards
over the schema, migrations, security headers and `.gitignore`.

**`tests/integration_tests.test.js`** — only external boundaries are mocked; the
real middleware and route handlers execute. Covers seller onboarding, checkout
and payment, reconciliation, the authorization matrix across every endpoint,
rate limiting, configuration loading and failure propagation.

**`tests/component_tests.test.jsx`** — rendered components in jsdom: product
cards, the order summary's totals and in-flight guard, and the error boundary.

Tests are written to find defects rather than inflate coverage, and were
validated by mutation testing — every fixed defect was reintroduced to confirm
the suite caught it. Highest-value cases:

- `authSeller` never returns `undefined`. Prisma **silently drops `undefined`
  from a `where` clause**, so a non-approved store once turned the seller
  dashboard into a full platform data leak.
- Cart `total` stays equal to the sum of item quantities under randomised
  operation sequences.
- Order pricing always comes from the database; quantities must be positive
  integers; addresses must belong to the buyer; coupons must be unexpired.
- Payment reconciliation is idempotent and only ever moves an order to paid.
- A search result is never overwritten by a slower, broader catalogue fetch.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `npm install` refuses to run | You are not on Node 22. Run `nvm use`. |
| Build fails on `publishableKey` | Clerk variables missing or malformed. Run `npm run check`. |
| `/admin` says not authorized | `ADMIN_EMAIL` does not match your **verified, primary** Clerk email. |
| Orders never show as paid | The reconciliation sweep is not running — check Inngest. It confirms payments every five minutes. |
| `/pricing` says plans are unavailable | Clerk billing is not enabled. Expected, and harmless. |
| `relation does not exist` | Migrations not applied — run `npm run migrate:deploy`. |
| Empty storefront | Database not seeded — run `npm run seed`. |
| First request is slow | Neon auto-suspends when idle; the next request wakes it. |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system and data model diagrams,
  the checkout sequence, and the reasoning behind the main design decisions.
- [docs/DEMO.md](docs/DEMO.md) — the three-minute walkthrough and fallback plan
  used to record the demo.

## License

[MIT](LICENSE)
