# GoCart

[![CI](https://github.com/ManavS24/GoCart/actions/workflows/ci.yml/badge.svg)](https://github.com/ManavS24/GoCart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-vendor e-commerce marketplace where independent sellers list products in
a shared storefront, a single basket can span several sellers, and an
administrator approves who goes live.

Built with Next.js 15 (App Router), Prisma on Neon Postgres, Clerk, Razorpay,
ImageKit and Inngest.

<!-- TODO(deploy): add hero screenshot -> docs/screenshots/storefront.png -->
<!-- TODO(deploy): add live demo URL and demo credentials -->

> **Live demo:** _not yet deployed_
> **Demo accounts:** _added after first deploy_

## Features

**Shoppers** — browse and search a multi-seller catalogue, server-persisted
cart, coupon validation, online or cash-on-delivery checkout, order history,
product ratings gated on an actual purchase.

**Sellers** — apply for a store, await approval, then manage products with
ImageKit uploads, toggle stock, update order status, and view earnings.
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
| Database | Neon Postgres via Prisma 6 |
| Auth & billing | Clerk |
| Payments | Razorpay payment links, confirmed by a polling sweep |
| Media | ImageKit |
| Background jobs | Inngest |
| Client state | Redux Toolkit |
| Tests | Vitest — 176 tests, no DB or network required |
| Hosting | Vercel |

## Quickstart

Requires Node 22 (see `.nvmrc`) and free accounts with
[Neon](https://neon.tech), [Clerk](https://clerk.com),
[Razorpay](https://razorpay.com), [ImageKit](https://imagekit.io) and
[Inngest](https://inngest.com).

```bash
npm install
cp .env.example .env      # fill in credentials
npm run check             # validates every variable, then pings the database
npx prisma migrate deploy # creates the schema
npm run seed              # 2 live stores, 1 pending, 16 products, coupons
npm run dev
```

Then open http://localhost:3000.

Two things that will otherwise cost you time:

- **`ADMIN_EMAIL` must be the email you sign up with**, or `/admin` stays locked
  and you cannot approve your own seller store.
- **Online payment is confirmed by polling, not by a webhook.** There is no
  webhook endpoint and no webhook secret: a scheduled sweep asks Razorpay every
  five minutes which payment links were paid and marks the matching orders. So
  a shopper can be charged up to five minutes before the order shows as paid,
  and the API keys alone are enough to take payments — including locally.

`npm run check` reports exactly which variables are missing or malformed and
whether the database is reachable, so a bad credential fails there rather than
inside Next, Prisma or Clerk.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) |
| `npm run check` | Validate `.env` and database connectivity |
| `npm run check -- --production` | The same, with deferred variables treated as required — the pre-release gate |
| `npm run seed` | Populate a demo catalogue |
| `npm run build` | `prisma generate` → `next build`. **Does not touch the database.** |
| `npm run migrate:deploy` | Apply pending migrations — a deliberate release step, not part of the build |
| `npm run migrate:status` | Show which migrations are applied and which are pending |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | Both test suites |
| `npm run test:unit` | Unit suite only |
| `npm run test:integration` | Integration suite only |

`npm run build` only compiles; it needs no database. Migrations are applied
separately — see *Releases*.

## Releases

Migrations are **not** part of the build. They used to be, which meant a schema
change landed while the previous version was still serving traffic, two
concurrent builds raced for the same lock, and rolling a deployment back left
the schema ahead of the code with nothing to reverse it.

Applying a migration is now something you do, in this order:

1. **Snapshot.** In Neon, create a branch from `main` — that is the rollback
   point, and it takes seconds.
2. **Migrate.** Run the *Migrate database* workflow in GitHub Actions (it asks
   for confirmation and prints the pending list first), or locally with a
   `DIRECT_URL` in scope:
   ```bash
   npm run migrate:status   # what is pending
   npm run migrate:deploy   # apply it
   ```
3. **Deploy.** Push to `main` as usual.

That order is only safe because migrations are **additive**: a new column is
nullable, a new table is unreferenced, nothing is dropped or narrowed. The old
code therefore keeps working against the new schema for the window between
steps 2 and 3. A test enforces this — a migration containing `DROP COLUMN`,
`DROP TABLE`, a rename, or an `ALTER COLUMN` that narrows a type or adds
`NOT NULL` will fail the suite unless it carries an explicit
`-- expand-contract:` note explaining the plan.

**To roll back**, redeploy the previous commit. The schema stays where it is,
which is harmless for an additive migration. If a migration itself must be
undone, restore the Neon branch from step 1 — there are no down migrations.

## Testing

Two entry points, neither requiring a database, network access or credentials.

**`tests/unit_tests.test.js`** — modules in isolation with Prisma, Clerk and
axios mocked: `safeInternalPath`, `authAdmin`, `authSeller`, all four Redux
slices, `makeStore`, and the assets module.

**`tests/integration_tests.test.js`** — only external boundaries are mocked;
the real middleware and route handlers execute. Covers the seller onboarding
flow, checkout and payment, reconciliation, the authorization matrix
across every endpoint, configuration loading, and failure propagation.

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

## Deployment

Deploys to Vercel from `main`; Neon holds the data. Nothing else is self-hosted,
and the whole stack fits in free tiers.

1. Import the repository in Vercel.
2. Add every variable from `.env.example` **before the first build** — pages
   wrapped in `<ClerkProvider>` are prerendered and the build fails on an
   invalid Clerk key.
3. Apply migrations **before** deploying, then deploy. The build no longer
   touches the database — see *Releases* below.
4. Nothing to configure at Razorpay: payments are confirmed by the scheduled
   sweep, which uses the same API keys as checkout. Online orders are refused
   with a 503 whenever those keys are absent, rather than taking a payment the
   app cannot confirm.
5. In Inngest, sync the app at `https://<your-app>/api/inngest`.
6. Seed the production database once: `npm run seed`.
7. Confirm the deployment is fully configured: `npm run check -- --production`,
   which treats deferred variables as required.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Build fails on `publishableKey` | Clerk env vars missing or malformed. Run `npm run check`. |
| `/admin` says not authorized | `ADMIN_EMAIL` does not match your signed-in Clerk email. |
| Orders never show as paid | The reconciliation sweep is not running — check Inngest. It confirms payments every five minutes. |
| `relation does not exist` | Migrations not applied — run `npx prisma migrate deploy`. |
| Empty storefront | Database not seeded — run `npm run seed`. |
| First request is slow | Neon auto-suspends when idle; the next request wakes it. |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system and data model diagrams,
  the checkout sequence, and the reasoning behind the main design decisions.
- [docs/DEMO.md](docs/DEMO.md) — the three-minute walkthrough, setup checklist
  and fallback plan used to record the demo.

## License

[MIT](LICENSE)
