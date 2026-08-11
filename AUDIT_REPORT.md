# Production Readiness Audit

**Repository:** GoCart — multi-vendor e-commerce marketplace
**Commit audited:** `6e2ed61` (branch `main`, working tree clean)
**Date:** 2026-08-11
**Auditor scope:** principal engineering / production readiness / QA / security / SRE
**Constraint honoured:** no application or source code was modified. Only this file was created.

---

## 1. Executive Summary

GoCart is a well-structured Next.js 15 App Router marketplace with genuinely
above-average engineering hygiene for its size: a real test suite (176 tests, all
passing), an environment preflight script, a documented architecture, a working
CI pipeline, an idempotency ledger for Stripe webhooks, and server-side price
recomputation at checkout. The authorization matrix is broadly correct — I probed
every mutating endpoint unauthenticated over real HTTP and all of them refused.

It is nevertheless **NOT READY** for production.

The blocking problems are concentrated in the money path and the dependency
surface, and none of them are caught by the existing suite:

1. **Next.js 15.3.5 carries an unpatched critical RCE plus ~30 other advisories.**
   `npm audit` reports 1 critical / 5 high / 2 moderate. Fix is a non-breaking
   bump to 15.5.23.
2. **A transient failure inside the Stripe webhook permanently loses the payment.**
   The event id is claimed in `ProcessedWebhookEvent` *before* the mutation, so
   Stripe's retry is short-circuited as a duplicate and the order is never marked
   paid. Reproduced (probe P2): money captured, order stuck unpaid, cart not cleared,
   and no reconciliation job exists to detect it.
3. **Sellers see and fulfil unpaid Stripe orders.** The buyer's own order list
   filters on `isPaid`; the seller's does not (probe P3). Abandoned checkouts appear
   in the seller queue as shippable orders.
4. **Every revenue figure counts unpaid orders.** Seller earnings and platform
   revenue both sum all orders regardless of `isPaid` (probe P4: an abandoned $900
   checkout inflates earnings from $100 to $1000).
5. **`GET /api/orders` has no authentication guard at all** and reaches the database
   for an anonymous caller — verified over real HTTP — and the resulting Prisma
   error, including the database host and port, is returned verbatim to that
   anonymous caller.
6. **User rows are provisioned only by an Inngest webhook with no fallback.**
   Address creation, cart persistence and order creation are all foreign-keyed to
   `User`. Until that async sync lands (or if the Clerk→Inngest wiring is not
   configured at all — it is not part of this repository), those writes fail.
7. **A saved cart can be silently wiped on a cold start** by the debounced upload
   racing the initial fetch.

There are also two systemic gaps rather than individual bugs: **there is no
observability** (no health endpoint, no structured logging, no metrics, no error
tracker — 38 bare `console.*` calls), and **there are no database indexes on any
foreign key**, so every seller and buyer query is a sequential scan.

The `docs/ARCHITECTURE.md` "known limitations" section is honest and accurate as
far as it goes, but it understates the state of the payment path.

---

## 2. Architecture / System Map

### Components

```
Browser (React 19 + Redux Toolkit, all pages 'use client')
   │
   ├─ Next.js 15.3.5 App Router  ── single Vercel deployment
   │    ├─ middleware.js → clerkMiddleware()   (attaches session; authorizes NOTHING)
   │    ├─ app/(public)/*  storefront, cart, orders, create-store
   │    ├─ app/store/*     seller dashboard  (client-side gate → /api/store/is-seller)
   │    ├─ app/admin/*     admin console     (client-side gate → /api/admin/is-admin)
   │    └─ app/api/*       21 route handlers — the only layer touching the database
   │
   ├─ Neon Postgres (Prisma 6, driverAdapters preview)
   ├─ Clerk         — sessions, user directory, `plus` billing plan
   ├─ Stripe        — Checkout Sessions + payment_intent webhooks
   ├─ ImageKit      — store logos and product images
   ├─ Inngest       — clerk/user.* sync, scheduled coupon expiry
   └─ OpenAI-compatible endpoint — optional product autofill
```

### Entry points

| Entry point | Auth | Notes |
| --- | --- | --- |
| `GET /api/products` | none | full catalogue, unpaginated, includes full `Store` rows |
| `GET /api/store/data?username=` | none | full store row, unpaginated products |
| `POST /api/stripe` | Stripe signature | webhook |
| `GET/POST/PUT /api/inngest` | Inngest signing key | webhook |
| 10 buyer endpoints | Clerk session | cart, address, orders, rating, coupon |
| 7 seller endpoints | `authSeller` → approved store id or `false` | |
| 6 admin endpoints | `authAdmin` → `ADMIN_EMAIL` allowlist | |

### Data flow — checkout (the critical flow)

```
Client ──POST /api/orders──► validate → address scoped to userId → coupon → products
                             (prices re-read from DB, never trusted from client)
                             group by storeId → one Order per store  [NOT in a transaction]
   ├─ STRIPE: create Checkout Session (orderIds in metadata) → return URL; cart NOT cleared
   │          Stripe ──payment_intent.succeeded──► /api/stripe
   │                     claim event id in ProcessedWebhookEvent  [BEFORE mutation]
   │                     → order.updateMany isPaid=true → user.cart = {}
   └─ COD:    user.cart = {} → confirmation
```

### Data model

`User (1)─(0..1) Store (1)─(n) Product`; `Order` fans out per store and holds a
JSON snapshot of the coupon; `OrderItem` has a composite PK `(orderId, productId)`;
`Coupon` and `ProcessedWebhookEvent` are standalone. `User.cart` is untyped JSONB.
All monetary columns are `DOUBLE PRECISION`.

---

## 3. Deployment Readiness Verdict

> ## **NOT READY**

Eight confirmed deployment blockers (F-01 … F-08 below). The application builds,
lints and tests cleanly, and its authorization matrix holds — but the payment
confirmation path can silently lose money, sellers are shown unpaid orders as
fulfillable, revenue reporting is wrong, and the runtime ships a dependency with
an unpatched critical RCE.

Realistic remediation: **F-01 (dependency bump), F-02 (webhook ordering), F-03
(seller `isPaid` filter), F-04 (revenue filter), F-05 (auth guard + error
sanitisation), F-06 (user upsert), F-08 (webhook secret)** are each small,
localised changes. This is a day or two of work, not a re-architecture.

---

## 4. Test Execution Summary

Environment: macOS (darwin 25.5.0), Node **v25.2.1** (note: `.nvmrc` pins **22**;
CI uses 22 — the audit ran on a newer major than production will), npm 11.6.2.

| # | Check | Command | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Clean install | `npm ci` | **PASS** | 701 packages, 13s. `postinstall` ran `prisma generate` successfully. |
| 2 | Dependency audit | `npm audit` | **FAIL** | 8 vulns: **1 critical, 5 high, 2 moderate**. See F-01. |
| 3 | Lint | `npm run lint` | **PASS** | `✔ No ESLint warnings or errors` |
| 4 | Unit tests | `npm run test:unit` | **PASS** | 68 tests |
| 5 | Integration tests | `npm run test:integration` | **PASS** | 108 tests |
| 6 | Full suite | `npm test` | **PASS** | `Test Files 2 passed (2) / Tests 176 passed (176)`, 405ms |
| 7 | Production build | `npx next build` (dummy Clerk keys, per CI) | **PASS** | 41 routes compiled; 41/41 static pages generated; middleware 85 kB |
| 8 | Typecheck | — | **N/A** | Project is plain JavaScript (`jsconfig.json`, no TypeScript). No static type gate exists. |
| 9 | Migration apply | `prisma migrate deploy` | **NOT RUN** | Requires a live `DATABASE_URL`. Docker daemon unavailable, no local Postgres. See §11. |
| 10 | Env preflight | `npm run check` | **NOT RUN** | Exits at "No .env file found"; the DB-reachability half needs live credentials. |
| 11 | Seed | `npm run seed` | **NOT RUN** | Requires live DB **and** live ImageKit credentials + network. |
| 12 | Server startup | `npx next start -p 3111` | **PASS** | Booted and served `GET /` → **200** with an unreachable database, i.e. the app starts without a DB. |
| 13 | Health check | `curl /api/health` | **FAIL** | **404** — no health/readiness endpoint exists. See F-14. |
| 14 | Unauthenticated GET matrix | `curl` × 9 endpoints | **PARTIAL FAIL** | 401 on `/api/cart`, `/api/address`, `/api/rating`, `/api/admin/is-admin`, `/api/admin/dashboard`, `/api/store/is-seller`. **`/api/orders` → 400 after hitting the database.** See F-05. |
| 15 | Unauthenticated POST matrix | `curl` × 10 endpoints | **PASS** | All mutating endpoints returned 401 (`/api/store/stock-toggle` returns 400 for missing input before its auth check — ordering nit, not a leak). |
| 16 | Stripe webhook, forged | `curl -X POST /api/stripe` no signature | **PASS** | 400, no mutation. Signature verification is enforced. |
| 17 | Security response headers | `curl -I /` | **FAIL** | No HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy. `X-Powered-By: Next.js` disclosed. See F-15. |
| 18 | Targeted audit probes | 14 probes, real route handlers, external boundaries mocked | **14/14 confirmed defects** | See below. |

### Probe harness (check 18)

Written to the scratchpad (`audit.probe.js`), never into the repository, reusing
the project's own mocking strategy: real route handlers and real middleware
execute; only Prisma, Clerk, Stripe, ImageKit, OpenAI and Inngest are doubled.
Run with `npx vitest run --config <scratchpad>/probe.config.mjs`. Result:
`Test Files 1 passed (1) / Tests 14 passed (14)` — every probe asserts the
presence of the defect, so 14/14 passing means all 14 hypotheses were confirmed.

Raw evidence emitted by the probes:

```
P1  where = {"OR":[{"paymentMethod":"COD"},{"AND":[{"paymentMethod":"STRIPE"},{"isPaid":true}]}]}
P1b status = 200  queried = 1            ← anonymous caller reached the database
P2  first delivery = 400 {"error":"ETIMEDOUT"}
P2  retry         = 200 {"received":true,"duplicate":true}   ← order never marked paid
P3  seller query = {"where":{"storeId":"store_1"},"include":{"user":true,...}}
P4  seller dashboard = {"totalOrders":2,"totalEarnings":1000,...}   ← $900 of it unpaid
P4b admin dashboard revenue = 1000.00
P5  coupon.create data = {"code":"X","discount":500,...,"createdAt":"1999-01-01"}
P5b = 400 {"error":"Cannot read properties of undefined (reading 'toUpperCase')"}
P6  order total = -40  status 200         ← negative order accepted
P7  status = 400  orders created = 2  | $transaction used = false
P8  persisted cart keys = a,nested  size = 1034   ← arbitrary JSON stored
P9  where = {"id":"o1","userId":"u1","orderItems":{"some":{"productId":"p1"}}} -> 200
P10 args = {"where":{"inStock":true,"store":{"isActive":true}},...}   ← no take/skip, no status filter
P11 update args = {"where":{"id":"o1","storeId":"store_1"},"data":{"status":"DELIVERED"}}
P11b update args (no orderId) = {"where":{"storeId":"store_1"},"data":{"status":"SHIPPED"}}
```

Live HTTP evidence (check 14), verbatim:

```
GET /api/orders -> 400 {"error":"\nInvalid `prisma.order.findMany()` invocation:\n\n\n
Can't reach database server at `127.0.0.1:5432`\n\nPlease make sure your database
server is running at `127.0.0.1:5432`."}
```

---

## 5. Findings

Severity is assigned on production impact, not on ease of reproduction.

---

### F-01 — Next.js 15.3.5 has an unpatched critical RCE and ~30 further advisories

- **Status:** ✅ **RESOLVED** — 2026-08-11. `npm audit` reports **0 vulnerabilities**
  (was 1 critical / 5 high / 2 moderate). See *Resolution* at the end of this finding.
- **Severity:** CRITICAL
- **Confidence:** CONFIRMED
- **Category:** Dependency vulnerability
- **Location:** [package.json:29](package.json#L29) — `"next": "15.3.5"`
- **Evidence:** `npm audit` reports `next` as **critical**, range
  `9.3.4-canary.0 - 16.3.0-preview.10`, `fixAvailable: {"name":"next","version":"15.5.23","isSemVerMajor":false}`.
  Advisories include *"Next.js is vulnerable to RCE in React flight protocol"*
  (GHSA-9qr9-h5gf-34mp), *"Improper Middleware Redirect Handling Leads to SSRF"*
  (GHSA-4342-x723-ch2f), *"Middleware / Proxy bypass in App Router applications via
  segment-prefetch routes"* (GHSA-267c-6grr-h53f, plus its incomplete-fix follow-up
  GHSA-26hh-7cqf-hhc6), *"Unauthenticated disclosure of internal Server Function
  endpoints"* (GHSA-955p-x3mx-jcvp), and multiple cache-poisoning and XSS entries.
  Also flagged: `postcss` (HIGH, path traversal / arbitrary `.map` read),
  `sharp` (HIGH, libvips CVEs), `js-yaml` (HIGH), `nanoid` (HIGH),
  `brace-expansion` (HIGH, DoS), `imagekit`/`uuid` (MODERATE).
- **Reproduction:** `npm ci && npm audit`
- **Impact:** Remote code execution on the serving runtime; middleware bypass is
  especially relevant here because `clerkMiddleware()` is what attaches the session
  every route handler reads. Cache poisoning against a Vercel-hosted storefront
  affects all visitors.
- **Root cause:** Pinned minor with no automated dependency updates; CI never runs
  `npm audit`, so the pipeline is green while the advisory count grows.
- **Recommended fix:** Bump to `next@15.5.23` (non-breaking per npm) and
  re-run the build + suite. Bump `js-yaml`, `nanoid`, `brace-expansion` via
  `npm audit fix`. Evaluate `imagekit@1.5.0` (major) separately or accept the
  moderate `uuid` finding with a documented exception. Add `npm audit --audit-level=high`
  to [.github/workflows/ci.yml](.github/workflows/ci.yml) and enable Dependabot.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed, and deeper than the version number).** Three compounding
causes, all now removed:

1. `next` was pinned to an **exact** version (`"next": "15.3.5"`, no range operator).
   Verified at [package.json:29](package.json#L29) before the change. An exact pin
   means no patch release can ever be picked up — not by `npm update`, not by a
   fresh `npm install`. The vulnerable version was structurally frozen in place.
2. **CI never audited.** [.github/workflows/ci.yml](.github/workflows/ci.yml) ran
   install → lint → test → build, so the pipeline stayed green while advisories
   accumulated. Nothing in the repository could ever have reported this.
3. **No automated dependency updates.** No Dependabot or equivalent configuration
   existed, so upgrades depended entirely on someone remembering to look.

An additional cause surfaced during the work and is not in the original writeup:
`next@15.5.23` itself **pins `postcss` to exactly `8.4.31` and `sharp` to `^0.34.3`**,
both of which are still within their advisory ranges. Upgrading `next` alone therefore
left two HIGH advisories (`GHSA-qx2v-qp2m-jg93` et al., `GHSA-f88m-g3jw-g9cj`) in the
tree, and npm's only proposed remedy was `next@16.3.0` — a breaking major.

**Exact remediation.**

- **Version range, not a bump.** `next` changed from the exact pin `15.3.5` to the
  range `^15.5.23`. This clears the critical advisory *and* permanently restores the
  ability to receive future patch and minor releases, which is the actual defect.
  Resolved to `next@15.5.23`.
- **Transitive overrides instead of a major upgrade.** Added an `overrides` block
  pinning `postcss` to `8.5.23`, `sharp` to `^0.35.3` and `uuid` to `^11.1.1`. These
  are not suppressions — the vulnerable code is physically replaced in the tree.
  The versions were not chosen arbitrarily: `next@16.3.0` (the version npm wanted to
  force) itself depends on **exactly `postcss@8.5.23` and `sharp@^0.35.3`**, verified
  via `npm view`. Adopting upstream's own resolved versions gives the same patched
  dependencies that a major upgrade would, without the breaking framework change.
- **`uuid` resolved rather than excepted.** The original recommendation offered a
  documented exception, since npm's only fix was downgrading `imagekit` 6.0.0 → 1.5.0
  (five majors, and `imagekit@6.0.0` is the latest published version — there is no
  fixed release on the 2+ line). Instead an override lifts the transitive `uuid`
  from 8.3.2 to 11.1.1. `imagekit` uses `uuid` in exactly one place —
  `dist/libs/signature/index.js` calls `v4()` with no arguments — so it was never
  reachable by GHSA-w5hq-g745-h8pq (a `buf` bounds check in v3/v5/v6) in the first
  place, but the override removes the vulnerable code regardless. **No exception is
  needed and none is claimed.**
- `js-yaml`, `nanoid` and `brace-expansion` fixed via `npm audit fix` (lock-only).
- **Recurrence prevention — CI gate.** Added an `npm audit --audit-level=high` step
  to [.github/workflows/ci.yml](.github/workflows/ci.yml), immediately after
  `npm ci`. A new high or critical advisory now fails the build; moderates are
  reported without blocking.
- **Recurrence prevention — automated updates.** Added
  [.github/dependabot.yml](.github/dependabot.yml): weekly npm updates with patch and
  minor grouped into one reviewable PR, majors kept separate so a breaking upgrade is
  always deliberate; monthly github-actions updates.

**Files changed.** `package.json` (range + `overrides`), `package-lock.json`
(resolution), `.github/workflows/ci.yml` (audit gate), `.github/dependabot.yml`
(new), `tests/unit_tests.test.js` (tests). **No application or source code was
modified** — the diff touches no file under `app/`, `lib/`, `components/`,
`middlewares/`, `inngest/`, `configs/`, `prisma/` or `scripts/`.

**Tests added.** A `describe('dependency floors')` block in
[tests/unit_tests.test.js](tests/unit_tests.test.js), 3 new tests (68 → 71 unit,
176 → 179 total). `npm audit` in CI catches *new* advisories; these lock in the
*specific* fixes so a revert cannot silently reintroduce them:

1. `next` is a **caret range** at or above 15.5.23 — the assertion rejects an exact
   pin outright, so it fails on the precise mistake that caused this finding rather
   than only on a low version number.
2. The `overrides` block exists and the resolved `postcss` / `sharp` / `uuid` meet
   their patched floors.
3. **Every** copy of an overridden package anywhere in `package-lock.json` is patched
   — this catches a nested vulnerable copy that a top-level-only check would miss,
   which is exactly the shape of the `next/node_modules/postcss` problem.

**Verification performed.**

| Check | Result |
| --- | --- |
| `npm audit` | **0 vulnerabilities** (was 8: 1 critical, 5 high, 2 moderate) |
| `npm audit --audit-level=high` | exit **0** (was exit 1) — the CI gate passes |
| `rm -rf node_modules && npm ci` | Clean install reproduces the patched tree, so CI's `npm ci` is verified, not just the local `npm install` |
| `npm test` | **179 passed** (176 pre-existing, all still green, + 3 new) |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npx next build` | Succeeds; all 41 routes build; Tailwind CSS bundle emitted (45 KB), confirming the `postcss` override did not break the CSS pipeline |
| `next start` runtime smoke | `GET /` 200, `GET /cart` 200, `GET /api/cart` 401, `POST /api/orders` 401 — unchanged behaviour |
| `imagekit` + `uuid@11` interop | Directly exercised: `getAuthenticationParameters()` (the only `uuid.v4()` call site) returns a valid token and signature; `ik.url()` produces the expected transformation URL |
| `sharp@0.35.3` loads | `libvips 8.18.3` (patched); also note `images.unoptimized: true` means Next's optimizer path is not exercised at runtime |
| Dependency drift | Audited the lockfile diff: among direct dependencies **only `next` changed** (15.3.5 → 15.5.23). `@clerk/nextjs`, `inngest`, `stripe`, `openai`, `prisma`, `@prisma/client`, `axios` all unchanged |
| **Mutation testing** | Each new test was proven to fail when its fix is reverted: restoring the exact pin `15.3.5` → test 1 fails (`expected a caret range, got "15.3.5"`); deleting `overrides` → test 2 fails; injecting a nested `postcss@8.4.31` into the lock → test 3 fails. Suite restored to 71 passing afterwards |

**Residual risk.**

- **Low — `next lint` deprecation.** Next 15.5 prints a notice that `next lint` is
  deprecated in favour of the ESLint CLI. `npm run lint` still exits 0 and reports
  correctly. Migrating the lint script is a separate concern and was deliberately
  **not** done here to keep this change attributable to F-01.
- **Low — overrides need review at the next major upgrade.** The `postcss`, `sharp`
  and `uuid` overrides are correct for `next@15.5.x` and `imagekit@6`. When Next is
  upgraded to 16+, the `postcss` and `sharp` entries become redundant and should be
  removed rather than left to silently constrain the tree. Dependabot majors arriving
  as separate PRs makes this a visible decision point.
- **Accepted — overrides are a tree-wide instruction.** `overrides` applies to every
  consumer of those packages, not just Next. Verified acceptable here: `postcss@8.5.23`
  is what `@tailwindcss/postcss` and `vite` already resolved to, and `sharp`/`uuid`
  have exactly one consumer each.
- **None outstanding for this finding.** No advisory is suppressed, deferred, or
  excepted.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-02 — A transient webhook failure permanently loses the payment confirmation

- **Status:** ✅ **RESOLVED** — 2026-08-11. The audit's own reproduction now recovers
  the payment: retry returns `{"received":true}` and the order is marked paid.
  See *Resolution* at the end of this finding.
- **Severity:** CRITICAL
- **Confidence:** CONFIRMED
- **Category:** Correctness / data integrity / payments
- **Location:** [app/api/stripe/route.js:14-23](app/api/stripe/route.js#L14-L23) and
  [app/api/stripe/route.js:25-59](app/api/stripe/route.js#L25-L59) (`handlePaymentIntent`)
- **Evidence:** The idempotency ledger row is created *before* any business mutation.
  Probe P2: with `checkout.sessions.list` rejecting (`ETIMEDOUT`), the first delivery
  returns `400 {"error":"ETIMEDOUT"}` having already inserted `evt_1`. Stripe's retry
  then hits `P2002` and returns `200 {"received":true,"duplicate":true}` — and
  `prisma.order.updateMany` is asserted never to have been called on either delivery.
- **Reproduction:** probe P2 in the scratchpad harness; in production, any timeout or
  Neon cold-start failure between line 23 and line 52 reproduces it.
- **Impact:** The customer is charged. The order stays `isPaid: false` forever, so it
  never appears in the buyer's order list ([app/api/orders/route.js:177-180](app/api/orders/route.js#L177-L180)
  filters on `isPaid`), and their cart is never cleared. Stripe exhausts its retries
  believing the endpoint acknowledged the event. There is no reconciliation job, no
  alert, and no manual repair path. This is silent, unrecoverable money loss.
- **Root cause:** "Claim then act" is the wrong order for a non-transactional handler.
  Idempotency requires either claiming inside the same transaction as the mutation, or
  a two-phase ledger (claim → mutate → mark complete) with retry of incomplete claims.
- **Recommended fix:** Wrap the ledger insert and the order mutation in a single
  `prisma.$transaction`, so a failure rolls the claim back and Stripe's retry
  reprocesses cleanly. (`order.updateMany` is idempotent, so this is safe.) Add a
  scheduled reconciliation that lists Stripe payment intents succeeded in the last
  24h and repairs any order still `isPaid: false`.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** The ledger conflated two different facts: *"this event
id has been seen"* and *"this event's work is done"*. `processedWebhookEvent.create`
committed on its own, immediately, and from then on any redelivery was rejected as a
duplicate — regardless of whether the work that was supposed to follow ever happened.
Everything between the claim and the mutation (a Stripe API round trip, then two
writes) therefore ran inside a window where a failure was **unrecoverable by
construction**: the only mechanism that could have retried it had already been
disarmed. It is not a missing transaction so much as a ledger that recorded the
wrong event.

**Design considered and rejected.** The original recommendation — put the claim and
the mutation in one `$transaction` — is not sufficient on its own, because the Stripe
`checkout.sessions.list` call sits between them and needs the session metadata to know
*which* orders to mutate. Two options were rejected:

- *Stripe call inside the transaction.* Holds a Postgres transaction open across an
  external HTTP round trip, pinning a Neon connection for its duration and risking a
  transaction timeout whenever Stripe is slow. Under a retry storm this exhausts the
  pool.
- *Stripe call before the claim.* Would issue a Stripe API request on every replayed
  delivery. The suite already asserts the opposite
  ([tests/integration_tests.test.js](tests/integration_tests.test.js), *"ignores a
  replayed delivery without touching orders"* → `expect(stripeListSessions).not.toHaveBeenCalled()`),
  and weakening that assertion to accommodate the fix was not acceptable.

**Exact remediation — a two-phase ledger**, the alternative named in this finding's
own root-cause note:

1. **Schema** ([prisma/schema.prisma](prisma/schema.prisma)) — added
   `completedAt DateTime?` to `ProcessedWebhookEvent`. `processedAt` now means
   *claimed*; `completedAt` means *done*.
2. **Claim no longer suppresses redelivery on its own**
   ([app/api/stripe/route.js](app/api/stripe/route.js), `claimEvent`). On a `P2002`
   the handler reads the existing row: a row with `completedAt` set is a genuine
   replay and short-circuits; a row without it is the debris of a failed attempt and
   is **reprocessed**. This is the actual fix — the recovery path that previously did
   not exist.
3. **Mutations and the completion mark commit together** in one
   `prisma.$transaction`. Nothing can mark the event done unless the order writes
   committed, and nothing can commit the order writes without marking it done.
4. **The Stripe lookup was hoisted out of the transaction**, before it opens, so no
   database transaction is ever held across a network call.
5. **`user.update` → `user.updateMany` for the cart clear.** Necessary, not
   incidental: inside a transaction, `update` against a not-yet-synced user row throws
   `P2025` and would roll back the payment confirmation — recreating this exact
   finding through the fix itself. `updateMany` matches zero rows without throwing, so
   a cosmetic cart clear can no longer abort a payment. (This is a robustness
   requirement of the transaction, not a fix for F-06, which remains open.)

Redelivery safety rests on both mutations being idempotent — `updateMany(isPaid: true)`
and `deleteMany(isPaid: false)` — so reprocessing an incomplete claim is always safe.

**Migration.** [prisma/migrations/20260811120000_webhook_event_completion/migration.sql](prisma/migrations/20260811120000_webhook_event_completion/migration.sql)
adds one nullable column. Additive and non-breaking: the previous release runs
unchanged against the new schema, so this needs no downtime and no deploy ordering
(relevant to F-26, which remains open). **Existing rows are deliberately left NULL** —
the old handler claimed before mutating, so an old row is not evidence the work
completed, and some of those rows *are* the lost payments. Leaving them incomplete
means replaying such an event from the Stripe dashboard now reprocesses it correctly
instead of being rejected as a duplicate, which gives operations a recovery path for
damage already done.

**Files changed.** `app/api/stripe/route.js`, `prisma/schema.prisma`,
`prisma/migrations/20260811120000_webhook_event_completion/migration.sql` (new),
`tests/integration_tests.test.js`. No other route, component or module was touched.

**Tests added/changed.** 108 → 114 integration tests (185 total).

*Added, all in the webhook lifecycle suite:*

1. **`reprocesses a retry after the first delivery failed, and the order ends up paid`** —
   the audit's exact reproduction. Delivery 1 claims then fails on a Stripe timeout;
   delivery 2 is reprocessed and the order is marked paid. This is the regression test
   for the finding.
2. **`completes the claim in the same transaction as the mutations`** — proves the
   completion mark is issued before the transaction callback returns.
3. **`leaves the claim incomplete when the transaction rolls back`** — a rollback must
   not mark the event done.
4. **`does not call Stripe again for an event already completed`** — guards the
   efficiency property that shaped the design.
5. **`reprocesses when the claim row cannot be read back`** — a vanished row falls
   through to reprocessing, never to silently dropping the event.
6. **`confirms payment even when the buyer row does not exist yet`** — encodes the
   invariant behind change 5 above. It mocks `user.update` to reject with `P2025`, so
   it fails if the cart clear ever reverts to a call that throws on a missing row,
   independently of which Prisma method the implementation happens to use.

*Changed (fixtures only, no assertion weakened):* the replay test now models a
**completed** claim, since that is what makes a delivery a genuine replay; the success
test asserts `user.updateMany`; the Prisma double gained `$transaction`,
`processedWebhookEvent.findUnique/update` and `user.updateMany` so it reflects the
current schema. The pre-existing assertions — including *"claims the event id before
mutating anything"* and *"no Stripe call on a replay"* — are all retained and still
pass.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **185 passed** (was 179; 176 original + 3 from F-01 + 6 new) — no pre-existing test was dropped or weakened |
| Audit probe P2 (the original reproduction) | Before: retry → `{"received":true,"duplicate":true}`, `order.updateMany` never called. **After: delivery 1 → 400 `ETIMEDOUT`; retry → 200 `{"received":true}`; order marked paid = `true`.** Payment recovered |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid 🚀` |
| `npx prisma generate` | Client generated successfully |
| Migration correctness | Cross-checked offline against `prisma migrate diff --from-empty --to-schema-datamodel`: Prisma's own DDL for the table is `"completedAt" TIMESTAMP(3)` — identical to what `init` + this migration produce. No schema drift |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | Each element of the fix was reverted in turn and the suite confirmed to fail: (a) making any claim suppress the retry — the original defect — fails tests 1 and 5; (b) moving the completion mark outside the transaction fails test 2; (c) reverting the cart clear to `user.update` fails test 6 and the success test. Suite restored to 114 passing after each |

An honest note on that mutation run: mutation (b) initially **passed**, because the
first version of test 2 compared invocation order against the `$transaction` call
rather than its completion, which cannot distinguish "inside the transaction" from
"immediately after it". The test double was given a commit marker and the assertion
rewritten; mutation (b) then failed as it should. The weak assertion was found and
fixed rather than accepted.

**Residual risk.**

- **Open, and now the dominant risk for this flow — no reconciliation job.** The
  second half of the recommended fix (a scheduled sweep of Stripe payment intents
  succeeded in the last 24h, repairing any order still `isPaid: false`) is **not
  implemented**. The handler is now self-healing across Stripe's retry window, but if
  every retry in that window fails, or the webhook secret is wrong (F-08), the payment
  is still lost with nothing to detect it. This depends on F-08 and on alerting from
  F-14, both still open. It is tracked in §12 and §13 and must not be considered
  closed by this fix.
- **Low — a "no checkout session found" result is treated as terminal.** The event is
  marked complete and returns 200, preserving previous behaviour. If Stripe's session
  list were ever eventually-consistent for a just-created session, such an event would
  be dropped. Not observed, and changing it would alter behaviour the suite asserts.
- **Low — interactive transactions require a TCP connection.** Route handlers run on
  the Node runtime (no `export const runtime = 'edge'` anywhere), where
  [lib/prisma.js](lib/prisma.js) uses a plain `PrismaClient`. If this route were ever
  moved to the edge runtime, the Neon HTTP adapter's transaction support would need
  re-checking.
- **Informational — historical damage is not auto-repaired.** Orders already lost to
  this bug stay unpaid until an operator replays the event from the Stripe dashboard,
  which the migration's NULL backfill deliberately makes possible.

- **Deployment blocker:** ~~YES~~ → **CLEARED** for the handler defect. The missing
  reconciliation job remains open and is captured under F-08/F-14.

---

### F-03 — Sellers are shown unpaid Stripe orders as fulfillable

- **Status:** ✅ **RESOLVED** — 2026-08-11. The seller list and the seller status
  update both filter on the shared payment predicate; the audit's own probe now
  shows the predicate present in the query. See *Resolution* at the end.
- **Severity:** CRITICAL
- **Confidence:** CONFIRMED
- **Category:** Business logic / financial correctness
- **Location:** [app/api/store/orders/route.js:39-43](app/api/store/orders/route.js#L39-L43)
- **Evidence:** Probe P3 —
  `{"where":{"storeId":"store_1"},"include":{"user":true,"address":true,"orderItems":{"include":{"product":true}}},"orderBy":{"createdAt":"desc"}}`.
  No `isPaid` predicate. Compare the buyer-facing query at
  [app/api/orders/route.js:177-180](app/api/orders/route.js#L177-L180), which *does*
  exclude unpaid Stripe orders. The two views disagree about what an order is.
- **Reproduction:** Start a Stripe checkout, abandon it at the payment page. The order
  row is created before redirect ([app/api/orders/route.js:109-127](app/api/orders/route.js#L109-L127))
  and appears immediately in `/store/orders` with the buyer's full shipping address
  and a status dropdown.
- **Impact:** A seller ships goods that were never paid for. At scale this is trivially
  abusable: a buyer can generate an unlimited queue of unpaid, shippable orders without
  ever entering card details. It also pollutes the seller's order count.
- **Root cause:** The `isPaid` filter was applied to the buyer view only; the seller
  view was never brought in line.
- **Recommended fix:** Apply the same predicate as the buyer query —
  `OR: [{paymentMethod: 'COD'}, {paymentMethod: 'STRIPE', isPaid: true}]` — or surface
  payment state explicitly in the UI and block status transitions on unpaid orders.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** Not simply a forgotten `where` clause. *"Which orders
count"* was never expressed anywhere as a single fact — it existed only as a literal
inlined into the buyer's query. The seller's query was written separately and never
had one. Two independent copies of a business rule, with nothing to hold them
together, so they drifted. Copying the literal a second time would fix this instance
and leave the mechanism that produced it fully intact.

**Exact remediation.**

1. **The rule now exists in one place** — [lib/placedOrder.js](lib/placedOrder.js)
   exports `PLACED_ORDER`, the `where` fragment meaning *an order that is real*: a COD
   order the moment it is placed, a Stripe order only once the webhook has confirmed
   payment.
2. **Seller order list** ([app/api/store/orders/route.js](app/api/store/orders/route.js)
   `GET`) — `where: {storeId, ...PLACED_ORDER}`. This is the reported defect.
3. **Seller status update** (same file, `POST`) — also guarded. Filtering the list
   alone would have been cosmetic: the endpoint accepted any order id, so an unpaid
   order remained fulfillable by direct API call. Switched from `update` to
   `updateMany` with `{id, storeId, ...PLACED_ORDER}`, so the payment guard is applied
   **in the same statement as the write** rather than as a separate read-then-write
   with a window between them. A zero `count` returns 404.
4. **Buyer order list** ([app/api/orders/route.js](app/api/orders/route.js) `GET`)
   re-pointed at the shared constant. Behaviourally identical — the predicate is
   character-for-character what it already had — but it is what makes the two views
   incapable of diverging again, which is the actual root cause. This is the one
   deliberate step beyond the reported symptom.

**One prerequisite change.** `updateMany` made an `orderId` guard mandatory. Prisma
drops an `undefined` key from a `where` clause (the footgun this codebase documents
elsewhere), so an unguarded `updateMany` with a missing `orderId` would have rewritten
the status of **every** order in the store — a far worse defect than the one being
fixed. `update` had been failing safe here only by accident, because Prisma rejects a
non-unique `where`. An explicit `400` now precedes the query.

**Files changed.** `lib/placedOrder.js` (new), `app/api/store/orders/route.js`,
`app/api/orders/route.js`, `tests/integration_tests.test.js`. Deliberately untouched:
`app/api/store/dashboard/route.js` and `app/api/admin/dashboard/route.js`, whose
revenue aggregates have the same missing predicate — that is **F-04** and is still open.

**Tests added/changed.** 114 → 120 integration tests (191 total).

1. **`hides unpaid stripe orders from the seller order list`** — the reported defect.
2. **`refuses to advance the status of an unpaid stripe order`** — 404, closing the
   direct-API route to fulfilling an unpaid order.
3. **`applies the payment guard in the same statement as the write`** — asserts no
   `findFirst`/`update` pair, i.e. no check-then-write window.
4. **`rejects a status update with no orderId instead of updating the whole store`** —
   guards the mass-update hazard introduced by `updateMany`.
5. **`both order lists filter on the same shared predicate`** — the root-cause test.
   Runs both endpoints and asserts their `OR` clauses are equal and match
   `PLACED_ORDER`, so a future edit to one side that diverges from the other fails.
6. **`counts a COD order but not an unconfirmed stripe one`** — asserts the predicate's
   meaning directly, independent of any query.

*Changed (one test, intent preserved):* `scopes an order status update to the seller
store` now reads `updateMany` instead of `update`; it still asserts the update is
scoped to `id` and `storeId`.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **191 passed** (was 185; +6) — no pre-existing test dropped or weakened |
| Audit probe P3 (original reproduction) | Before: `where` was exactly `{"storeId":"store_1"}`. **After: `{"storeId":"store_1","OR":[{"paymentMethod":"COD"},{"AND":[{"paymentMethod":"STRIPE"},{"isPaid":true}]}]}`** |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| Full-suite re-run after F-02 | 120/120 webhook and order tests green together; no interaction between the two fixes |
| **Mutation testing** | Four reverts, each caught: (a) seller list unfiltered — the original defect — fails tests 1 and 5; (b) status-update guard removed fails test 2; (c) `orderId` guard removed fails test 4; (d) **seller re-forks its own subtly-wrong copy of the predicate** fails tests 1 and 5, confirming the divergence guard actually works |

**Verified relationship to F-21 (documented, not fixed).** The `orderId` guard above
independently resolves **part** of F-21. Re-running that finding's probe splits it:

- *F-21(a) — still open.* An arbitrary `status` still reaches Prisma unchecked:
  `EVIDENCE P11a status value reaching Prisma = {"status":"DELIVERED"}`. No enum
  validation and no forward-only state machine.
- *F-21(b) — now resolved.* `EVIDENCE P11b missing orderId -> 400
  {"error":"missing details: orderId"} | prisma touched = 0`.

F-21 remained open for (a) at the time; **it was closed directly on 2026-08-11** — see
that finding's Resolution.

**Residual risk.**

- **Behaviour change, intended.** Unpaid Stripe orders vanish from the seller
  dashboard, and a status update against one now returns 404. Any such order
  in flight at deploy time disappears from the seller's queue — which is the point.
  Paid and COD orders are unaffected.
- ~~**Open** — the same predicate is still missing from the revenue aggregates in both
  dashboards, so sellers can see earnings that include orders no longer in their order
  list.~~ **Closed 2026-08-11 by F-04**, which applied the predicate to all four
  aggregates. The dashboards and the order lists now describe the same set of orders.
- **Open — the seller list still returns the full buyer `User` row**, including their
  cart. That is F-16, untouched.
- **Low — no reconciliation of stale unpaid rows.** Abandoned Stripe orders remain in
  the table indefinitely, now invisible rather than deleted. Harmless to sellers, but
  they continue to accumulate; related to the F-02 reconciliation item still open.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-04 — Seller earnings and platform revenue include unpaid orders

- **Status:** ✅ **RESOLVED** — 2026-08-11. The audit's own probe now reports seller
  earnings of **100** (was 1000) and platform revenue of **"100.00"** (was "1000.00")
  for the same data. See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** Business logic / financial reporting
- **Location:** [app/api/store/dashboard/route.js:16](app/api/store/dashboard/route.js#L16),
  [app/api/store/dashboard/route.js:28](app/api/store/dashboard/route.js#L28);
  [app/api/admin/dashboard/route.js:19-31](app/api/admin/dashboard/route.js#L19-L31)
- **Evidence:** Probe P4 — with one paid $100 order and one abandoned $900 checkout,
  the seller dashboard reports `{"totalOrders":2,"totalEarnings":1000}`. Probe P4b —
  the admin dashboard reports `revenue = 1000.00`. Both should report 100.
- **Reproduction:** probes P4 / P4b.
- **Impact:** Every financial number the platform shows is wrong and inflated by the
  abandonment rate — typically 60–80% of started checkouts. If seller payouts are ever
  driven from this figure, the platform overpays. `totalOrders` is likewise inflated.
- **Root cause:** Same missing `isPaid` predicate as F-03; aggregation reads the raw
  order table.
- **Recommended fix:** Filter both aggregates on paid-or-COD. Consider deriving revenue
  from a dedicated paid-orders view so the predicate is defined once.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** The same absent concept behind F-03, surfacing in a third
and fourth place: the aggregates were written directly against the `Order` table with
no notion of which rows represent real orders. Money was defined as *"the sum of every
row"*, so revenue tracked the checkout abandonment rate. The second half of the
recommended fix — *"so the predicate is defined once"* — was already delivered as part
of F-03 (`lib/placedOrder.js`); this finding is the remaining call sites adopting it.

**Exact remediation.** Four aggregate reads, all now sharing `PLACED_ORDER`:

- [app/api/store/dashboard/route.js](app/api/store/dashboard/route.js) —
  `where: {storeId, ...PLACED_ORDER}`. This fixes **both** `totalEarnings` and
  `totalOrders`, which derive from the same query.
- [app/api/admin/dashboard/route.js](app/api/admin/dashboard/route.js) —
  `order.count({where: PLACED_ORDER})` for the headline count, and
  `where: PLACED_ORDER` on the `findMany` that feeds **both** the revenue sum and the
  orders-per-day chart. Filtering one and not the other would have left the chart
  contradicting the number above it.

`store.count()` and `product.count()` are deliberately left unfiltered — an order
predicate does not apply to those models — and a test now pins that so a copy-paste
cannot filter the wrong model.

**Deliberately not done here.** The admin route still loads every matching order row
into Node memory to sum it, rather than using a Prisma `aggregate`. That is **F-19**
(performance) and remains open. It is also not a straight swap: `allOrders` is returned
to the client for the chart, so the rows are needed regardless and only the sum could
move into the database. Changing the query shape now would have entangled the two
findings.

**Files changed.** `app/api/store/dashboard/route.js`,
`app/api/admin/dashboard/route.js`, `tests/integration_tests.test.js`. No new module
was needed — the shared predicate already existed.

**Tests added/changed.** 120 → 125 integration tests (196 total).

1. **`excludes unpaid stripe orders from earnings and the order count`** — the seller
   half of the reported defect.
2. **`reports earnings equal to the sum the order list would show`** — ties the money
   figure to the same set the seller can actually see.
3. **`excludes unpaid stripe orders from revenue, the count and the chart`** — the
   admin half, asserting the `findMany` and the `count` agree with each other.
4. **`counts stores and products without an order predicate`** — guards against
   filtering the wrong model.
5. **`every order read across buyer, seller and both dashboards shares the predicate`** —
   the F-03 root-cause test, extended from two call sites to all four. It runs every
   endpoint and asserts each `where` both matches `PLACED_ORDER` and has an `OR`
   identical to it, with per-site failure messages, so any future divergence names
   the endpoint that drifted.

*Changed (one test, intent preserved):* `scopes the dashboard to the resolved store`
now asserts `where.storeId` rather than the whole object, since the object legitimately
carries the predicate too. Its purpose — the query is scoped to the seller's store —
is unchanged.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **196 passed** (was 191; +5) — no pre-existing test dropped or weakened |
| Audit probe P4 (seller) | Before: `{"totalOrders":2,"totalEarnings":1000}`. **After: `{"totalOrders":1,"totalEarnings":100}`** on identical data |
| Audit probe P4b (admin) | Before: `revenue = 1000.00`. **After: `revenue = 100.00 \| orders = 1 \| chart rows = 1`** |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | Four reverts, each caught: (a) seller earnings unfiltered — the original defect — fails 3 tests; (b) admin count unfiltered fails the admin test; (c) admin revenue/chart query unfiltered fails 2 tests; (d) **a half-applied fix** (revenue filtered but counts forgotten) fails 4 tests, which is the realistic way this regresses |

**A limitation of this verification, stated plainly.** The exclusion happens in the
`where` clause, so what these tests prove is that the correct predicate is sent to
Prisma — not that Postgres filters correctly, which is Prisma's contract, not this
codebase's. To make the probe demonstrate the effect rather than just the query, its
Prisma double was changed to actually evaluate the `where` against a mixed row set;
that is what produces the 1000 → 100 evidence above. End-to-end confirmation against a
real database remains outstanding and is tracked in §11.

**Residual risk.**

- **Informational — figures will drop at deploy.** Seller earnings, seller order
  counts, platform revenue and the orders-per-day chart will all fall, by the share of
  Stripe checkouts that were abandoned. This is a correction, not a regression, but it
  will look like one on the dashboard and should be expected by whoever reads it first.
- ~~**Open — F-19 (performance).** The admin route still materialises every placed order
  in memory to sum it.~~ **Closed 2026-08-11 by F-19**, which replaced the scan with a
  Prisma `aggregate` and bounded the chart query to the 30 days it displays.
- ~~**Open — F-18 (float money).** Revenue is still summed in floating point.~~
  **Closed 2026-08-11 by F-18/F-19**: the sum now happens in Postgres and is formatted
  through the exact cent helpers.
- **None outstanding for this finding.** The four aggregates and the two lists now
  describe one and the same set of orders.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-05 — `GET /api/orders` has no auth guard and leaks database internals to anonymous callers

- **Status:** ✅ **RESOLVED** — 2026-08-11. Live re-run of the original `curl`:
  `GET /api/orders` → **401 `{"error":"not authorized"}`**, and no handler returns a
  raw error any more. See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** Security — missing authorization / information disclosure
- **Location:** [app/api/orders/route.js:173-192](app/api/orders/route.js#L173-L192)
  (`GET`) — no `if (!userId) return 401`, unlike every sibling handler
- **Evidence:** Live HTTP, unauthenticated:
  `GET /api/orders -> 400 {"error":"\nInvalid \`prisma.order.findMany()\` invocation:\n\nCan't reach database server at \`127.0.0.1:5432\`..."}`.
  The request reached Prisma. Probe P1b confirms `order.findMany` is invoked once with
  no session. Probe P1 shows that when `userId` is `undefined` the emitted `where` is
  `{"OR":[...]}` — the `userId` key is present but undefined, and **Prisma silently
  drops undefined from a where clause**, returning every user's orders. This is exactly
  the footgun [docs/ARCHITECTURE.md:106-112](docs/ARCHITECTURE.md#L106-L112) documents
  and defends against in `authSeller` — but the guard is absent here.
- **Reproduction:** `curl http://<host>/api/orders` with no `Authorization` header.
- **Impact:** Two distinct problems. (a) Information disclosure — the raw Prisma error,
  including the database hostname and port, is returned to an unauthenticated internet
  caller. This pattern (`error.code || error.message`) is used by **18 of 21 route
  handlers**, so it is systemic. (b) A latent cross-tenant data leak: the only thing
  preventing the entire `Order` table from being returned is that Clerk's `getAuth`
  currently yields `null` rather than `undefined` for signed-out requests. That is an
  external library's implementation detail load-bearing for tenant isolation.
- **Root cause:** Guard omitted on one handler; error responses never sanitised.
- **Recommended fix:** Add `if (!userId) return NextResponse.json({error:'not authorized'},{status:401})`
  as the first statement of `GET`. Separately, replace `error.code || error.message`
  everywhere with a logged-internally / generic-externally pattern — `/api/products`
  ([app/api/products/route.js:24](app/api/products/route.js#L24)) already does this
  correctly and should be the template.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** Two defects with one shared cause: **both the guard and
the error shape were per-handler conventions rather than enforced properties.**
21 handlers each hand-wrote their own auth check and their own catch block, so
correctness depended on 21 authors each remembering. One forgot the guard; eighteen
wrote the leak. The test that should have caught the guard was itself a
hand-maintained list of ten endpoints that `GET /api/orders` was never added to — the
omission was duplicated in the code *and* in its test, which is why it survived.

**Exact remediation.**

*The guard* — [app/api/orders/route.js](app/api/orders/route.js) `GET` now returns 401
before touching Prisma, matching every sibling handler.

*The leak* — [lib/apiError.js](lib/apiError.js) is now the single place that decides
what a failure looks like to a caller: the full error goes to `console.error`, the
caller gets `{"error":"An internal server error occurred."}`. All **31** catch-block
responses across **20** route files now delegate to it. The generic message is
`/api/products`' existing wording, kept deliberately so the template named in the
recommendation is the one that won.

*Status codes changed, deliberately: 400 → 500 for unhandled failures.* A database
outage answering `400 Bad Request` is both wrong and operationally harmful — it is the
reason the F-14 checklist item *"alert on 5xx rate > 1%"* could never have fired. The
one exception is the Stripe webhook, where signature verification was moved into its
own block so an unverifiable payload stays **400**: that genuinely is a bad request,
and reporting it as a server fault would misrepresent it to both Stripe and any alert.

**The structural fix, which is the part that matters.** Fixing one guard and 31 catch
blocks leaves the mechanism that produced them intact. Two invariants are now enforced
by construction rather than by convention:

1. **Every route on disk is covered.** The anonymous matrix walks `app/api` and
   asserts each `route.js` is registered, then drives *every* exported handler with an
   anonymous request. Each must refuse it **and reach no data** (`readsPerformed()`
   must be empty — that is the assertion which would have caught this finding).
   Endpoints meant to be public are named in an explicit `PUBLIC` allow-list with the
   reason each is safe. This turned 10 hand-listed cases into 29 generated ones.
2. **No handler may hand-roll an error response.** A test scans every `route.js` for
   `error: error.*` and fails with the offending route names. The behavioural tests
   prove the helper is safe; this proves every handler actually uses it.

**Files changed.** `lib/apiError.js` (new), `app/api/orders/route.js`,
`app/api/stripe/route.js`, and 19 further route files (catch blocks only),
`tests/integration_tests.test.js`.

**Tests added/changed.** 125 → 162 integration tests (233 total).

- **29 generated anonymous-access tests**, one per non-public handler.
- **`registers every route module that exists on disk`** — catches a new endpoint that
  was never wired into the matrix.
- **5 leak tests** driving real endpoints with the genuine Prisma error text captured
  in this audit, asserting the response matches none of
  `/prisma|neon\.tech|5432|invocation|P1001|database server/i`.
- **`still records the full error on the server`** — sanitising the response must not
  also blind the operator.
- **`no route hand-rolls an error response`** — the exhaustive static guard.
- **`leaves deliberate validation messages intact`** — deliberate messages such as
  `missing order details.` are contract and must survive; only unhandled failures go
  generic.

*Changed (5 tests, intent preserved):* assertions of `400` on internal-failure paths
now expect `500`, matching the deliberate status change. Each still asserts the request
failed and no mutation occurred; one also gained a "does not leak `P1001`" assertion.

**Verification performed.**

| Check | Result |
| --- | --- |
| **Live HTTP — the original reproduction** | `GET /api/orders` unauthenticated: **`401 {"error":"not authorized"}`**. Previously `400` with `` Can't reach database server at `127.0.0.1:5432` `` |
| Live HTTP — other reads | `/api/store/data` → `500 {"error":"An internal server error occurred."}` (previously leaked the Prisma error); `/api/cart`, `/api/address` → 401 |
| Source scan | `grep -rn "error.code \|\| error.message\|error: error\." app/api/` → **clean** |
| Full suite | **233 passed** (was 196; +37) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) guard removed from `GET /api/orders` — the original defect — fails its generated test; (b) `apiError` leaking `error.code`/`message` again fails 6 tests; (c) **one handler reverting to a hand-rolled catch block**; (d) **a new unguarded endpoint added to disk** fails `registers every route module` |

An honest note: mutation (c) initially **passed**. The leak tests were a hand-picked
list of five endpoints — the very weakness that caused this finding — so reverting a
sixth handler went unnoticed. That is what prompted the exhaustive static guard, after
which (c) fails as it should. The hand-picked list was not left in place.

**Residual risk.**

- **Behaviour change — clients now show a generic message on internal failure.** Toasts
  that previously surfaced `P2003` or a Prisma message now read *"An internal server
  error occurred."* This is the intended trade, and it makes two open findings harder
  to diagnose from the UI alone: **F-06** (a missing user row surfaced as a `P2003`
  toast) and **F-11** (the coupon `TypeError`). Both are still open, both still log in
  full server-side, and neither is masked — only relocated to where it belongs.
- **Open — F-14.** Internal failures now return 5xx, which is the precondition for
  alerting, but no alerting, structured logging or error tracker exists yet. The signal
  is correct and still unwatched.
- **Low — `/api/store/stock-toggle` POST answers 400 before authenticating.** It
  validates input ahead of its auth check, so an anonymous caller gets 400 rather than
  401. It reaches no data, and the generated test asserts that; it is recorded as a
  documented exception rather than silently reordered, since that handler is otherwise
  outside this finding.
- **Low — the `PUBLIC` allow-list is a judgement call.** Three entries
  (`/api/products` GET, `/api/store/data` GET, `/api/stripe` POST) are deliberately
  reachable anonymously, each with its reason recorded next to it. Adding a fourth is
  now an explicit, reviewable act rather than an oversight.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-06 — User rows are provisioned only by an unconfigured webhook, with no fallback

- **Status:** ✅ **RESOLVED** — 2026-08-11. Every authenticated write now provisions
  its own `User` row from the Clerk session before writing, so checkout no longer
  depends on the Inngest sync having landed. See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED (code) / LIKELY (production frequency)
- **Category:** Correctness / external integration / broken critical flow
- **Location:** [inngest/functions.js:4-18](inngest/functions.js#L4-L18) — the only
  `prisma.user.create` in the codebase (verified by grep across `app/`, `lib/`,
  `inngest/`; no `user.upsert` exists anywhere)
- **Evidence:** `Order`, `Address` and `Rating` all carry FKs to `User`
  ([prisma/migrations/20260725175540_init/migration.sql:152,167,173](prisma/migrations/20260725175540_init/migration.sql#L152)),
  and `Order_userId_fkey` is `ON DELETE RESTRICT`. `POST /api/cart` does
  `prisma.user.update` ([app/api/cart/route.js:14-17](app/api/cart/route.js#L14-L17)),
  which raises `P2025` when the row is absent. `POST /api/address` and `POST /api/orders`
  raise `P2003` (FK violation). The Clerk→Inngest event source is external
  configuration and is not present in this repository; nothing in the deploy steps of
  [README.md:122-138](README.md#L122-L138) verifies it beyond "sync the app".
- **Reproduction:** Sign up a brand-new account and immediately add an address or place
  an order, before the async sync completes — or with the Clerk→Inngest integration
  not configured at all, in which case it never completes.
- **Impact:** New users cannot check out. `docs/ARCHITECTURE.md` states "code that reads
  it treats absence as normal" — correct for reads, but every **write** path assumes the
  row exists. If the integration is misconfigured this is a 100% failure rate on the
  primary revenue flow, surfacing to the user as a toast reading `P2003`.
- **Root cause:** Asynchronous provisioning on the critical path with no synchronous
  fallback and no startup verification.
- **Recommended fix:** Add an idempotent `ensureUser(userId)` helper that upserts from
  the Clerk session, and call it at the top of every authenticated write path. Keep the
  Inngest sync for profile updates and deletion. Add the Clerk→Inngest wiring to the
  deployment checklist as a verified step.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** A hard, synchronous data dependency satisfied only
asynchronously, by a trigger that does not live in this repository. Four tables —
`Address`, `Order`, `Rating`, `Store` — are foreign-keyed to `User`
([migration.sql:152,167,173,176](prisma/migrations/20260725175540_init/migration.sql#L152)),
and `prisma.user.update` fails outright on a missing row, yet the sole `user.create`
in the codebase sat inside an Inngest handler
([inngest/functions.js:9](inngest/functions.js#L9)). The architecture doc's claim that
*"code that reads it treats absence as normal"* was true and beside the point: reads
tolerated absence, **writes could not**, and nothing reconciled the two. Absent the
Clerk→Inngest integration, this is not a race — it is a permanent 100% failure of
checkout for every account.

**Exact remediation.** [lib/ensureUser.js](lib/ensureUser.js) provisions the row from
the Clerk session, and the five authenticated write paths call it immediately after
their auth check: `POST /api/cart`, `POST /api/address`, `POST /api/rating`,
`POST /api/orders`, `POST /api/store/create`.

Four properties make it safe to put on the hot path:

1. **Create, never update.** It early-returns when the row exists. This is not an
   optimisation but a correctness requirement: an upsert whose update branch wrote
   profile fields would clobber `User.cart` on every write, turning a provisioning fix
   into universal cart loss. A test asserts the saved cart survives.
2. **One primary-key lookup in the common case.** Clerk is contacted only when the row
   is genuinely absent — once per user, ever — so the steady-state cost is a single
   indexed read, not an API call per write.
3. **A lost creation race is success.** If the Inngest sync or a concurrent first write
   wins, `P2002` is swallowed: both outcomes leave exactly the row this exists to
   guarantee. Any other error propagates.
4. **No `"null null"` names.** Interpolating absent Clerk name fields is what produces
   that string — which the Inngest handler still does. This falls back through
   `firstName lastName` → `username` → `email` → `userId`.

Reads deliberately do **not** call it: they already treat absence as normal, and
provisioning is not a read's job.

**Files changed.** `lib/ensureUser.js` (new), and the five route files above,
`tests/integration_tests.test.js`. `inngest/functions.js` is untouched — the sync
still owns profile updates and deletion, exactly as recommended.

**Tests added/changed.** 162 → 174 integration tests (245 total).

- **5 generated tests**, one per write path, each asserting the write succeeds with the
  row absent and that the correct row was created from the Clerk account.
- **`does not touch Clerk or write when the row already exists`** — pins the
  short-circuit.
- **`treats a concurrent creation as success rather than an error`** — the `P2002` race.
- **`surfaces a genuine failure rather than continuing into the write`** — a `P1001`
  must not be swallowed, and the dependent write must not run.
- **`never writes the string "null null" as a name`** and **`falls back to the email,
  then the id`** — the name-derivation ladder.
- **`never overwrites an existing row, so a saved cart survives`** — guards the cart
  against the upsert mistake described above.
- **`every route that writes a User-owned row provisions it first`** — the structural
  guard. Scans every `route.js` for a write to a `User`-owned table and fails naming
  any that does not ensure the row, so a new handler cannot reintroduce the class.

*Changed (one fixture):* `asShopper` now also provides an existing `User` row, since a
signed-in shopper normally has one; tests that need it absent override afterwards.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **245 passed** (was 233; +12) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) dropping `ensureUser` from a write path — the original defect — fails that path's test *and* the structural guard; (b) removing the existence short-circuit fails the "does not touch Clerk" and cart-survival tests; (c) treating the `P2002` race as an error fails the concurrency test |

**A process note.** During mutation testing my backup filenames collided in `/tmp`
(`$(basename)` is `route.js` for every route), and the restore step overwrote
`app/api/address/route.js` with the contents of `app/api/orders/route.js`. The suite
caught it immediately (5 failures). The file was rebuilt from `git show HEAD` with the
F-05 and F-06 changes reapplied, the mutations were re-run with per-file backups, and
all three still fail as intended. Recorded because the earlier mutation numbers were
produced under the broken restore and should not be trusted on their own.

**Residual risk.**

- **Open, and the reason this is not fully closed operationally — the Clerk→Inngest
  integration is still unverified.** The application no longer *depends* on it for
  provisioning, which was the blocker. It is still required for profile updates
  (`clerk/user.updated`) and deletions (`clerk/user.deleted`); without it, names,
  emails and avatars silently go stale and deleted Clerk accounts keep their rows.
  Added to §12 as a verified deployment step.
- **Low — extra latency on a user's very first write.** One Clerk `getUser` call, once
  per account. Subsequent writes cost one indexed primary-key lookup.
- **Low — a stale row is never refreshed.** `ensureUser` deliberately does not update
  an existing row, so if the Inngest sync is missing, a row created here keeps the name
  and avatar captured at first write. Correct ownership, but worth knowing.
- **Informational — F-05 interaction.** A provisioning failure now surfaces to the user
  as a generic 500 rather than a `P2003`, with the detail in the server log.
- **Unverified — the FK behaviour itself.** That `address.create` genuinely fails
  without the parent row is inferred from the schema, not executed, since no database
  is available (§11). The fix does not depend on that detail being exact: it guarantees
  the row either way.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-07 — Multi-store checkout is not transactional

- **Status:** ✅ **RESOLVED** — 2026-08-11. The audit's own probe now reports
  `status = 500 | $transaction used = true | cart cleared = false`: the basket commits
  as one unit or not at all. See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** Data integrity / concurrency
- **Location:** [app/api/orders/route.js:96-128](app/api/orders/route.js#L96-L128) —
  `prisma.order.create` inside a `for` loop, no `$transaction`
- **Evidence:** Probe P7 — with the second `order.create` throwing, the response is
  `400` while `orders created = 2` (one committed, one failed) and
  `$transaction used = false`.
- **Reproduction:** probe P7; in production, any connection blip mid-loop on a
  multi-seller basket.
- **Impact:** A basket spanning three sellers can leave one or two committed orders
  while the buyer is told the order failed. The buyer's cart is not cleared, so they
  retry and duplicate the successful orders. For the Stripe path the damage is worse:
  orders may be committed and *no* Checkout Session created, leaving permanent unpaid
  orphans that also inflate F-04's revenue figures and count against the `forNewUser`
  coupon check at [app/api/orders/route.js:51-56](app/api/orders/route.js#L51-L56).
- **Root cause:** Multi-row creation treated as independent writes.
- **Recommended fix:** Wrap the per-store loop in `prisma.$transaction(async (tx) => …)`.
  For the Stripe path, either create the session inside the transaction boundary with
  compensation on failure, or create orders in a `PENDING_SESSION` state promoted only
  after the session exists.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** One business operation implemented as N independent writes.
A basket is atomic to the buyer — they either placed an order or they did not — but the
handler committed one row per seller in a loop, so any failure partway left a partial
basket with no record that it was partial. The cart was then left intact (correctly,
as the buyer's retry mechanism), which converted a partial failure into duplicate
orders on the retry.

**Exact remediation.**

1. **Totals are computed before the transaction opens**, so it holds a connection only
   for the writes.
2. **All per-store orders are created inside one `prisma.$transaction`.** All commit or
   none do.
3. **The COD cart clear moved inside that transaction.** Previously the orders and the
   cart could disagree: orders committed, cart clear failed, buyer re-orders. It uses
   `updateMany` for the reason established in F-02 — a missing user row must not roll
   back a completed checkout.
4. **The Stripe leg compensates.** If `checkout.sessions.create` fails after the orders
   commit, the just-created orders are deleted before the error propagates.

**Design decision, and why not the alternative.** The recommendation offered creating
the Stripe session *inside* the transaction boundary. I rejected that for the same
reason as in F-02: it holds a Postgres transaction open across an external HTTP round
trip, pinning a Neon connection for its duration and risking transaction timeouts —
and doing it on the checkout path means the pool is under most pressure exactly when
Stripe is slowest. Compensation keeps the transaction short.

The compensating delete is scoped `{id: {in: orderIds}, isPaid: false}`, deliberately
matching the webhook's cancellation guard, so a payment that somehow landed in the
interval can never be destroyed by cleanup. A cleanup failure is logged and swallowed
so the **original** Stripe error still reaches the caller rather than being masked by a
secondary one.

The `PENDING_SESSION` alternative was also rejected: it needs a schema change and a new
state that every order query would have to learn about, days after F-03 and F-04 spent
effort collapsing order-visibility down to one shared predicate.

**Files changed.** `app/api/orders/route.js`, `tests/integration_tests.test.js`.

**Tests added/changed.** 174 → 181 integration tests (252 total).

1. **`creates every per-store order inside one transaction`** — asserts both writes and
   the cart clear land before the transaction callback returns, using the commit marker
   built for F-02.
2. **`reports failure and commits nothing when a later store fails`** — the reported
   defect: a second-store failure must not report success or clear the cart.
3. **`does not clear the cart when the checkout fails`** — the cart is the buyer's only
   retry path.
4. **`keeps a stripe cart intact until the webhook confirms payment`** — guards the
   pre-existing behaviour that only the webhook clears a Stripe cart.
5. **`undoes the orders when the stripe session cannot be created`** — the compensation.
6. **`never deletes an order that has been paid during cleanup`** — pins the `isPaid`
   guard on the delete.
7. **`still reports the original failure if cleanup itself fails`** — a cleanup error
   must not mask the real cause.

*Changed (one test, intent preserved):* the COD test asserts `user.updateMany` rather
than `user.update`, reflecting the move into the transaction. It still asserts the cart
is cleared for that user.

**Verification performed.**

| Check | Result |
| --- | --- |
| Audit probe P7 (original reproduction) | Before: `status = 400, orders created = 2, $transaction used = false` — one order committed while the caller was told it failed. **After: `status = 500 \| $transaction used = true \| cart cleared = false`** |
| Full suite | **252 passed** (was 245; +7) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| Whole probe set re-run | 14/14. The six still-open findings (P5, P6, P8, P9, P10, P11a) **still reproduce**, confirming nothing was silently closed by this change |
| **Mutation testing** | (a) removing the transaction wrapper — the original defect — fails tests 1 and 3; (b) removing the Stripe compensation fails 5 and 6; (c) dropping the `isPaid` guard from cleanup fails 5 and 6; (d) moving the cart clear back outside the transaction fails 1 |

**Residual risk.**

- **Accepted — a narrow compensation window remains.** Between the transaction
  committing and the compensating delete, a crash of the serverless invocation would
  leave unpaid orphan orders. This is inherent to spanning a database and an external
  service without two-phase commit, and it is now *bounded*: such orders are excluded
  from every list and aggregate by F-03/F-04, so they are invisible rather than
  harmful. They are the same rows the F-02 reconciliation job should sweep.
- **Interaction with F-22 — orphans still count toward `forNewUser`.** The `forNewUser`
  check counts *all* of a user's orders, so a stranded unpaid order can still make a
  genuinely new user ineligible. F-22 fixed this for *redemption* counting, which uses
  the placed-order predicate, but deliberately did not change the pre-existing
  `forNewUser` query. **Still open.**
- **Low — transaction duration.** The transaction now spans N order inserts plus one
  cart update. For a basket touching many sellers this is longer than a single insert,
  though still far shorter than it would be with a Stripe call inside it.
- **Unverified — rollback itself.** That Postgres rolls the partial basket back is the
  database's contract, exercised here through a double. Confirming it end to end needs
  a real database (§11).

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-08 — `STRIPE_WEBHOOK_SECRET` is deliberately deferred, disabling all payment confirmation

- **Status:** ✅ **RESOLVED** — 2026-08-11. Card checkout is now refused at runtime
  when the secret is unset (503, no order created, Stripe never called), and
  `npm run check -- --production` fails the deploy. See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** Configuration / deployment
- **Location:** [scripts/check-env.mjs:42](scripts/check-env.mjs#L42) (marked *not*
  required), [README.md:71-73](README.md#L71-L73), [README.md:133-135](README.md#L133-L135)
  (step 4 of 6, after deploy)
- **Evidence:** `stripe.webhooks.constructEvent` at
  [app/api/stripe/route.js:11](app/api/stripe/route.js#L11) throws when the secret is
  absent or stale. Live probe against a server with no Stripe env:
  `POST /api/stripe -> 400 {"error":"Neither apiKey nor config.authenticator provided"}`.
  `npm run check` prints `[ skip ]` for this variable and exits 0.
- **Reproduction:** Follow the documented deploy order. Between step 3 (deploy) and
  step 4 (set the secret), the site is live and accepting Stripe checkouts whose
  webhooks all 400.
- **Impact:** Every payment taken in that window is captured by Stripe and never
  reflected in the application: order stays unpaid, cart is never cleared, buyer sees
  nothing in their order history. Stripe retries for ~3 days then gives up. Combined
  with F-02 there is no reconciliation to recover any of it.
- **Root cause:** A hard runtime requirement classified as optional to make the
  first-deploy story smoother.
- **Recommended fix:** Deploy with Stripe checkout disabled (COD only) until the secret
  is set, or gate the storefront behind a maintenance flag for the interval. Promote
  `STRIPE_WEBHOOK_SECRET` to required in `check-env.mjs` for production, and have
  `POST /api/orders` refuse `paymentMethod: 'STRIPE'` when it is unset rather than
  taking money it cannot confirm.
- **Deployment blocker:** **YES**

#### Resolution — 2026-08-11

**Root cause (confirmed).** A hard runtime requirement classified as optional to make
the first deploy smoother — and, underneath that, **nothing connected the ability to
take a payment to the ability to confirm one**. The two halves of the payment flow were
configured independently: `POST /api/orders` would happily create a Stripe session with
no idea whether `/api/stripe` could verify the resulting webhook. The deferral was then
written into the documented deploy order, so the window was not an accident but the
prescribed path.

**Exact remediation.**

1. **Runtime refusal — the load-bearing change.**
   [app/api/orders/route.js](app/api/orders/route.js) rejects
   `paymentMethod: 'STRIPE'` with **503** when `STRIPE_WEBHOOK_SECRET` is unset. It is
   placed immediately after payment-method validation, before any database work, so no
   order is created and Stripe is never called. Cash on delivery is untouched: refusing
   cards must not take the storefront down with it.
2. **Pre-release gate.** [scripts/check-env.mjs](scripts/check-env.mjs) gains a third
   requirement level. `STRIPE_WEBHOOK_SECRET` moves from `false` to `'production'`:
   still skippable locally, but **required** under
   `npm run check -- --production`, which is now the documented last step before
   release. `OPENAI_*` stay genuinely optional, so the distinction the original design
   was reaching for is preserved rather than flattened.
3. **Honest local output.** A plain `npm run check` no longer lists the secret as an
   unremarkable `skip` among fifteen `ok`s; it prints what the omission costs —
   *"card checkout will be refused (cash on delivery still works)"*.
4. **Documentation corrected.** [README.md](README.md) said *"Everything except payment
   confirmation works without it"*, which was the belief that made this dangerous.
   It now states that card checkout is refused until the secret is set and why, deploy
   step 4 carries the same warning, and a new step 7 runs the strict preflight.

**Why refusal rather than a maintenance flag.** The alternative in the recommendation —
gating the whole storefront — trades a total outage for a partial one. COD is a
complete, working checkout path; taking the catalogue offline to protect the card path
would cost more than it saves. Refusing only the unconfirmable payment method is the
narrower correct action.

**Files changed.** `app/api/orders/route.js`, `scripts/check-env.mjs`, `README.md`,
`tests/integration_tests.test.js`.

**Tests added/changed.** 181 → 186 integration tests (257 total).

1. **`refuses a STRIPE order when the webhook secret is unset`** — 503 with an
   actionable message.
2. **`creates no order and calls Stripe not at all when refusing`** — the refusal must
   be early: no order row, no transaction, no Stripe call. This is what makes it a
   refusal rather than a late failure that still leaves debris.
3. **`still accepts cash on delivery while card payment is unavailable`** — the
   storefront stays open.
4. **`allows a STRIPE order once the secret is configured`** — no regression to the
   normal path.
5. **`refuses an empty-string secret, not just an absent one`** — an empty Vercel
   variable is the realistic misconfiguration.

*Changed (one fixture):* the global `beforeEach` now sets `STRIPE_WEBHOOK_SECRET`,
modelling a correctly configured deployment; the tests above delete it explicitly.

**Verification performed.**

| Check | Result |
| --- | --- |
| Preflight, local, secret unset | `[ skip ]` plus an explicit note that card checkout will be refused |
| Preflight, `--production`, secret unset | `[ MISS ] STRIPE_WEBHOOK_SECRET`, `1 required variable(s) missing`, **exit 1** |
| Preflight, `--production`, secret set | `[  ok  ]`, all required variables present |
| Full suite | **257 passed** (was 252; +5) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the runtime refusal — the original exposure — fails 3 tests; (b) moving the refusal *after* order creation fails the "no order, no Stripe call" test; (c) demoting the variable back to optional flips the strict preflight from `[ MISS ]` + exit 1 to `[ skip ]` |

A note on that last one: my first attempt to mutation-test the preflight compared exit
codes and was **inconclusive** — the database-connectivity check also exits 1 against
the dummy credentials, masking the signal. Re-run comparing the reported status of the
variable itself, which isolates it. Recorded because an exit-code-only check here would
have looked like a pass without proving anything.

**Residual risk.**

- **Open, and unaddressed by this fix — a *stale* or *wrong* secret is undetectable at
  order time.** Presence is checked; correctness cannot be, because the only proof is a
  webhook Stripe has not sent yet. A rotated-but-not-updated secret reproduces the
  original loss exactly. This is precisely what the **F-02 reconciliation job** (still
  open) exists to catch, and it is the strongest remaining argument for building it.
  The README troubleshooting row *"Orders never show as paid — webhook stale"* still
  applies.
- **UX — the Stripe radio button remains visible** on the cart page while card payment
  is unavailable, so a shopper can select it and receive the 503 message. Hiding it
  would require exposing configuration to the client, which means a second source of
  truth that can drift from the secret's actual presence; a clear refusal was preferred
  over a flag that can lie. Worth revisiting if the window is ever expected to be long.
- **Low — `--production` is opt-in.** The gate only helps if it is run. It is now
  documented as deploy step 7 and listed in the scripts table, but nothing forces it;
  wiring it into a release pipeline would close that gap.

- **Deployment blocker:** ~~YES~~ → **CLEARED**

---

### F-09 — A saved cart can be silently wiped on a cold start

- **Status:** ✅ **RESOLVED** — 2026-08-11. The cart slice now distinguishes "empty"
  from "not loaded", and nothing is written back until it has been read.
  See *Resolution* at the end.
- **Severity:** HIGH
- **Confidence:** CONFIRMED (logic) / LIKELY (frequency)
- **Category:** Correctness / data loss / race condition
- **Location:** [lib/features/cart/cartSlice.js:6-19](lib/features/cart/cartSlice.js#L6-L19)
  and [app/(public)/layout.jsx:25-37](app/(public)/layout.jsx#L25-L37)
- **Evidence:** On mount with a signed-in user, two effects fire: one dispatches
  `fetchCart`, the other dispatches `uploadCart` with `cartItems` still `{}`.
  `uploadCart` schedules a 1000 ms timer that reads state *at fire time* and POSTs it.
  If `fetchCart` has not resolved within 1000 ms, the timer fires with the empty
  initial state and persists `{}` over the user's stored cart.
  [README.md:148](README.md#L148) documents exactly the condition that makes this
  likely: *"First request is slow — Neon auto-suspends when idle."*
- **Reproduction:** Sign in with a non-empty saved cart against a cold (auto-suspended)
  Neon instance; `GET /api/cart` exceeds 1s; the cart is overwritten with `{}`.
- **Impact:** Users lose their basket. Because the client then re-renders from the
  server-fetched state, the loss is not visible until the next session.
- **Root cause:** The upload effect is not gated on the fetch having completed; the
  reducer cannot distinguish "empty" from "not yet loaded".
- **Recommended fix:** Add a `status: 'idle' | 'loading' | 'loaded'` field to the cart
  slice and make `uploadCart` a no-op unless `status === 'loaded'`.
- **Deployment blocker:** **NO** (fix before launch)

#### Resolution — 2026-08-11

**Root cause (confirmed).** The cart state could not represent what it needed to. An
empty `cartItems` meant two different things — *"this shopper's basket is empty"* and
*"we have not read their basket yet"* — and the upload path could not tell them apart,
so it wrote the second one back as if it were the first. The debounce made it a race
rather than a certainty, and the README's own note that Neon *"auto-suspends when
idle"* describes exactly the condition that loses it.

**Exact remediation.** [lib/features/cart/cartSlice.js](lib/features/cart/cartSlice.js)
gains a `status` field — `'idle' | 'loading' | 'loaded' | 'failed'` — driven by the
`fetchCart` lifecycle, and `uploadCart` writes only when it reads `'loaded'`.

Two details carry the fix:

- **The status is read when the debounce timer fires, not when the upload is
  scheduled.** An upload queued while the fetch is still in flight is *deferred*, not
  dropped: if the cart arrives inside the one-second window, that same timer writes the
  correct cart. Checking at schedule time would silently discard it.
- **A failed fetch resolves to `'failed'`, not `'loaded'`.** After a failed read the
  saved cart is *unknown*, which is not the same as empty; leaving uploads blocked
  keeps the fix from reintroducing the very loss it exists to prevent, one error path
  over.

The gate lives in the thunk rather than in the layout effect that happens to trigger
it, so every caller is covered by one rule.

**Files changed.** `lib/features/cart/cartSlice.js`, `tests/unit_tests.test.js`.
`app/(public)/layout.jsx` is untouched — the effects there are correct once the slice
can answer the question they were implicitly asking.

**Tests added/changed.** 71 → 77 unit tests (263 total).

1. **`does not write anything back before the cart has been fetched`** — the defect.
2. **`writes the fetched cart, not the empty state, when the fetch is slow`** — the
   full cold-start sequence: nothing wiped during the slow fetch, correct cart written
   once it lands.
3. **`still writes an upload queued during loading once the cart arrives in time`** —
   pins fire-time evaluation.
4. **`stays blocked when the fetch fails, rather than guessing the cart is empty`**.
5. **`tracks the load status across the fetch lifecycle`**.
6. **`distinguishes a genuinely empty cart from one not yet loaded`** — both have
   `cartItems: {}`; only the loaded one may be written. This is the ambiguity the whole
   finding rests on.

*Changed (4 tests, intent preserved):* two `toEqual` assertions on cart state now
include `status`, and the two existing `uploadCart` tests mark the store loaded first —
which is the new precondition for any upload, not a relaxation of what they check.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **263 passed** (was 257; +6) |
| Consumer check | All five readers of the slice (`Navbar`, `Counter`, `ProductDetails`, the cart page, the public layout) select `cartItems` or `total` only — none reads the slice wholesale, so the new field breaks no component |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the gate — the original defect — fails 3 tests; (b) **moving the gate to schedule time**; (c) marking a failed fetch as `'loaded'` fails the failure-path test |

Mutation (b) initially **passed**. My code comment asserted that a queued upload still
succeeds once the cart arrives, but no test exercised that path — the layout happens to
re-dispatch on load, which masked the difference. Test 3 was added specifically to
distinguish the two, after which (b) fails. A claim in a comment that no test can
falsify is not a guarantee.

**Residual risk.**

- **Accepted — a cart cannot sync at all after a failed fetch, for that page load.**
  Items added still work locally and are uploaded once a later fetch succeeds, but if
  the shopper leaves first, those additions are lost. This is the deliberate trade:
  losing an unsaved addition is recoverable, overwriting a saved basket is not.
- **Open — F-10 makes this silent.** The upload still runs inside a `setTimeout` whose
  rejection the thunk's `try/catch` cannot see, so a blocked or failed sync produces no
  user-visible signal. Untouched here; it is the next finding.
- **Low — one redundant write per load.** When `fetchCart` resolves, `cartItems` gets a
  new reference and the layout dispatches an upload of the cart just received. Harmless
  and idempotent, but it is one avoidable request per page load.
- **Unverified in a browser.** The sequence is proven with fake timers against the real
  store; there are still no component or end-to-end tests (F-19/§10), so the effect
  ordering in `app/(public)/layout.jsx` is reasoned about rather than executed.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-10 — Cart-sync failures are invisible: the error handler cannot catch them

- **Status:** ✅ **RESOLVED** — 2026-08-11. The debounce is awaited by the thunk, so a
  failed write now rejects it and is recorded in state instead of becoming an unhandled
  rejection. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Error handling / observability
- **Location:** [lib/features/cart/cartSlice.js:8-17](lib/features/cart/cartSlice.js#L8-L17)
- **Evidence:** The `axios.post` lives inside a `setTimeout` callback. The enclosing
  `try/catch` returns before the timer fires, so `rejectWithValue` is unreachable — a
  rejected upload becomes an unhandled promise rejection. The thunk always fulfils.
- **Reproduction:** Make `POST /api/cart` fail (e.g. the F-06 missing-user case).
  No toast, no rejected action, no Redux state change.
- **Impact:** Cart persistence silently stops working. Combined with F-06 this is the
  most likely production symptom of a broken Inngest sync — and it is undetectable
  from the client.
- **Root cause:** Debounce implemented inside the thunk rather than around its dispatch.
- **Recommended fix:** Move the debounce outside the thunk (or return a promise that
  resolves when the timer's request settles) so rejections propagate.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** The thunk's lifetime did not cover the work it was
responsible for. `setTimeout` returns immediately, so the thunk resolved roughly a
second before its own request began: by the time `axios.post` settled there was no
longer a `try` block to catch it, no pending thunk to reject, and no caller listening.
The error handling was not weak — it was **unreachable**, and `uploadCart` reported
success unconditionally, including when the write had failed.

**Exact remediation** — [lib/features/cart/cartSlice.js](lib/features/cart/cartSlice.js):

1. **The thunk awaits the debounce** instead of scheduling work and returning.
   `waitForQuiet()` resolves when the cart has been quiet for a second, and the request
   then runs *inside* the thunk, where the existing `catch` and `rejectWithValue`
   finally apply.
2. **A superseded wait is resolved, not abandoned.** Cancelling with `clearTimeout`
   alone would leave every earlier dispatch's promise pending forever, trading an
   unobservable failure for a leak. Superseded waits resolve as `'superseded'` and
   their thunks settle as no-ops.
3. **Outcomes are distinguishable.** The thunk returns `{saved}`, `{skipped:'superseded'}`
   or `{skipped:'not-loaded'}`, so a skip cannot be mistaken for a save or a failure.
4. **Failures are recorded.** A new `syncError` field is set on `uploadCart.rejected`
   and cleared on success. Propagating an error nobody stores would have left the
   finding's actual complaint — *invisible* — intact.

**Files changed.** `lib/features/cart/cartSlice.js`, `tests/unit_tests.test.js`.

**Tests added/changed.** 77 → 84 unit tests (270 total).

1. **`rejects the thunk when the write fails, instead of reporting success`** — the
   defect: the dispatched action is now `uploadCart.rejected` carrying the server's
   payload.
2. **`records the failure in state so a stalled sync is detectable`**.
3. **`clears the recorded failure once a write succeeds again`** — a stale error must
   not persist.
4. **`surfaces a network error with no response body`** — the `error.message` fallback.
5. **`reports a getToken failure rather than swallowing it`** — an expired session
   fails visibly and never reaches the network.
6. **`settles every superseded dispatch instead of leaving it pending`** — three rapid
   dispatches produce two `superseded` and one `saved`, with a single POST.
7. **`does not record an error when an upload is skipped rather than failed`** — the
   F-09 gate produces a fulfilled action with `{skipped:'not-loaded'}` and no
   `syncError`.

*Changed (one assertion):* the documented initial state now includes `syncError: null`.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **270 passed** (was 263; +7), with no unhandled rejections reported by the runner |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) putting the debounce back inside the thunk — the original defect — fails 5 tests; (b) abandoning superseded waits fails test 6 **by timing out after 5,014 ms**, which is the dangling-promise symptom itself; (c) removing the `rejected` reducer fails 4 tests |

**Residual risk.**

- **Open — nothing renders `syncError` yet.** The failure is now observable in state,
  but no component reads it, so a shopper still sees no indication that their cart has
  stopped saving. Wiring it to a toast or a small banner is a product decision; a
  deliberate one is now possible, which it was not before. Recorded in §12.
- **Low — no retry.** A failed write is reported and dropped; the next cart change
  triggers a fresh attempt. There is no backoff or queue, so a cart changed once during
  an outage stays unsaved until the shopper touches it again.
- **Low — the debounce state is module-level.** `debounceTimer` and `supersedeWait` are
  shared across every store instance in a process. Harmless as used (uploads are
  dispatched only from the browser, one store per tab), but it would be wrong if a
  server-rendered request ever dispatched an upload.
- **Unverified in a browser.** Proven with fake timers against the real store; there
  are still no component or end-to-end tests (§10).

- **Deployment blocker:** NO — now resolved regardless.

---

### F-11 — Admin coupon creation is unvalidated mass assignment; a >100% discount yields negative orders

- **Status:** ✅ **RESOLVED** — 2026-08-11. The audit's probes now report
  `discount 500 -> 400 ... | written = 0`, only the seven real columns stored, a missing
  code answered with a validation error, and `P6 order total = 0` instead of −40.
  See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Input validation / business logic
- **Location:** [app/api/admin/coupon/route.js:17-28](app/api/admin/coupon/route.js#L17-L28);
  consumed at [app/api/orders/route.js:99-101](app/api/orders/route.js#L99-L101)
- **Evidence:** Probe P5 — the request body is passed to `prisma.coupon.create({data: coupon})`
  verbatim, including a client-supplied `createdAt: "1999-01-01"` and `discount: 500`.
  Probe P5b — a body with no `code` produces
  `400 {"error":"Cannot read properties of undefined (reading 'toUpperCase')"}`.
  Probe P6 — a 500% coupon on a $10 item produces `order total = -40` with HTTP 200.
- **Reproduction:** probes P5, P5b, P6.
- **Impact:** Admin-authenticated, so not a privilege boundary — but a single typo
  (500 instead of 50, or a missing `%` convention) creates orders with negative totals
  that flow into revenue aggregates, and for the Stripe path produces a negative
  `unit_amount` that Stripe rejects with an opaque error. No schema validation exists
  anywhere in the codebase.
- **Root cause:** No request-body schema validation on any endpoint.
- **Recommended fix:** Introduce a validation library (zod) and parse every request body.
  Minimally: allowlist coupon fields and clamp `discount` to `0 < d <= 100`, and clamp
  the computed order total at `>= 0`.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** Two failures of trust, one at each end of the coupon's life.
At creation, the parsed request body *was* the database row — the caller chose which
columns existed and what they contained, so `createdAt` was writable and `code` was
assumed to be a string. At use, the order pricing path treated `coupon.discount` as
inherently sane, with no bound between a stored number and the money arithmetic it
drives. Neither end validated, so each relied on the other being correct.

**Exact remediation.**

1. **[lib/couponInput.js](lib/couponInput.js)** — a pure `parseCouponInput` that returns
   either a row or an error. It **names all seven columns explicitly**, so nothing the
   caller invents is written and `createdAt` stays the database's; requires a usable
   `code` and `description` with length bounds; requires `discount` to be a finite
   number in `0 < d <= 100`; requires `expiresAt` to parse and to be in the future; and
   coerces the three flags to real booleans.
2. **[app/api/admin/coupon/route.js](app/api/admin/coupon/route.js)** now parses before
   writing and returns **400** with the specific reason. A missing code is a validation
   error rather than the `TypeError` it used to be.
3. **[app/api/orders/route.js](app/api/orders/route.js)** clamps the discounted subtotal
   at `>= 0`. This is not redundant: validating new coupons does nothing about rows that
   already exist — seeded ones, or any written before the fix — and the pricing path
   must not hand money back on their account.

**A deliberate deviation from the recommendation: no validation library was added.**
Introducing zod to parse *one* endpoint would add a runtime dependency whose value stays
unrealised while twenty other handlers remain unvalidated — and F-01 has just finished
demonstrating what dependency surface costs. The recommendation's own "minimally" path
is what is implemented here. The broader *"parse every request body"* work belongs with
**F-20** (unvalidated cart JSON) and **F-21** (unvalidated order status), both still
open; whichever is addressed first is the right moment to decide on a shared library,
since that is when there are three call sites to justify it rather than one.

**Files changed.** `lib/couponInput.js` (new), `app/api/admin/coupon/route.js`,
`app/api/orders/route.js`, `tests/unit_tests.test.js`, `tests/integration_tests.test.js`.

**Tests added/changed.** 84 → 95 unit and 186 → 194 integration tests (289 total).

*Unit — the validator in isolation (11 tests):* the seven-column contract; invented
columns including `createdAt` dropped; discounts above 100 and at/below 0 rejected;
boundaries 100 and 0.5 accepted; non-numeric discounts rejected rather than stored as
`NaN`; the missing-code crash; description required and both text fields bounded;
invalid, past and exactly-now expiries rejected; flags coerced; and the exact shape the
admin form sends accepted — the last of these guards against validation that is correct
but incompatible with the only UI that calls it.

*Integration — creation (5 tests):* a 500% discount refused with nothing written; a
missing code and a missing body answered 400 rather than crashing; only allowlisted
columns reaching Prisma; and a valid coupon still created and its expiry job still
scheduled.

*Integration — pricing (3 tests):* a stored 500% coupon producing a total of **0**, not
−40; a legitimate 100% coupon pricing at exactly 0; and an ordinary 10% discount
unchanged at 9, so the clamp does not distort normal pricing.

*Changed (one fixture):* an existing coupon test posted `{code, discount}` only, which
is no longer a valid coupon. Completed with a description and expiry; its assertions —
upper-casing and expiry scheduling — are untouched.

**Verification performed.**

| Check | Result |
| --- | --- |
| Audit probe P5 | Before: `coupon.create data = {...,"discount":500,...,"createdAt":"1999-01-01"}`. **After: `discount 500 -> 400 {"error":"discount must be greater than 0 and at most 100"} \| written = 0`**, and stored columns are exactly the seven real ones |
| Audit probe P5b | Before: `400 {"error":"Cannot read properties of undefined (reading 'toUpperCase')"}`. **After: `400 {"error":"coupon code is required"}`** |
| Audit probe P6 | Before: `order total = -40 status 200`. **After: `order total = 0 status 200`** |
| Seed compatibility | The three seeded coupons (20%, 10%, 15%, +365d expiry) all satisfy the new rules |
| Full suite | **289 passed** (was 270; +19) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) writing the body straight to Prisma again — the original defect — fails 4 tests; (b) removing the discount upper bound fails 2; (c) replacing the allowlist with a spread of the input fails 2; (d) removing the order-total clamp fails the stored-bad-coupon test |

**Residual risk.**

- **Open — twenty other endpoints still parse nothing.** This finding's surface is
  closed, but the root cause as the report states it (*"no request-body schema
  validation on any endpoint"*) is only partly addressed. F-20 and F-21 remain open and
  carry the rest.
- **Low — a 100% coupon plus a Plus membership yields a £0 Stripe session.** With no
  shipping and a full discount the total is 0, and Stripe rejects a zero-amount
  checkout, so the order fails with a generic 500. Pre-existing rather than introduced —
  a 100% discount was always accepted — and it now fails loudly instead of attempting a
  negative charge. Worth handling explicitly (route a zero-total order down the COD
  path) if full-value coupons are ever issued.
- **Low — existing out-of-range rows are not repaired.** The clamp makes them harmless
  at checkout, but a coupon with `discount: 500` sitting in the table still displays
  that figure in the admin list. A one-off data fix would be needed to clean it up.
- **Informational — no per-coupon usage cap.** Unlimited redemption by the same account
  is **F-22**, untouched here.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-12 — `authAdmin` trusts `emailAddresses[0]` without checking verification status

- **Status:** ✅ **RESOLVED** — 2026-08-11. Authorization now resolves the primary
  address by id and requires Clerk to have verified it. **This also closes §11 item 4**:
  the fix removes the dependency on that unanswered question rather than waiting for it.
  See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED (code) / UNVERIFIED (exploitability against a live Clerk tenant)
- **Category:** Security — authentication / privilege escalation
- **Location:** [middlewares/authAdmin.js:18-20](middlewares/authAdmin.js#L18-L20)
- **Evidence:** `const email = user.emailAddresses[0]?.emailAddress?.toLowerCase()`.
  Clerk returns *all* email addresses on the account, verified or not, and exposes the
  primary via `primaryEmailAddressId` — which is not consulted. There is no
  `verification.status === 'verified'` check.
- **Reproduction:** Requires a live Clerk tenant to determine whether an unverified
  secondary address can occupy index 0 and whether Clerk blocks claiming an address
  belonging to no existing account. **This is the unverified part of the finding.**
- **Impact:** Two failure modes. Benign: an admin with several addresses is locked out
  of `/admin` because index 0 is not the one in `ADMIN_EMAIL`. Severe: if an unverified
  address can land at index 0, any user who adds the configured `ADMIN_EMAIL` to their
  own account gains full admin — store approval, coupon issuance, platform revenue.
  Because `ADMIN_EMAIL` values are typically guessable (`admin@<domain>`), this deserves
  to be closed regardless of which case holds.
- **Root cause:** Identity derived from an array index rather than from the primary,
  verified identifier.
- **Recommended fix:** Resolve via `primaryEmailAddressId` and require
  `verification.status === 'verified'`. Longer term, move the admin flag to Clerk
  private metadata or a roles table so it is not derived from a mutable identifier.
- **Deployment blocker:** NO — but fix before exposing the admin console publicly.

#### Resolution — 2026-08-11

**Root cause (confirmed).** An authorization decision derived from an array index and
an unproven claim. `emailAddresses[0]` assumes two things Clerk never promises: that
position 0 is the address the person actually signs in with, and that the account is
entitled to it at all. A Clerk account may hold several addresses, and an entry that
has not completed verification is only an assertion by whoever typed it. Combined with
`ADMIN_EMAIL` values that are guessable by construction (`admin@<domain>`), that is an
admin-console takeover contingent on Clerk's array ordering and duplicate handling.

**Exact remediation.** [middlewares/authAdmin.js](middlewares/authAdmin.js) resolves the
address whose `id` equals `user.primaryEmailAddressId`, requires
`verification.status === 'verified'` exactly, and only then compares against the
allowlist. Every other shape — no primary named, a primary id matching no address, a
missing or non-`verified` verification record — returns `false`. The helper's existing
fail-closed contract (never `undefined`, never a throw escaping) is preserved.

**This closes the audit's own most important open question.** §11 item 4 recorded that
determining exploitability needed a live Clerk tenant: whether an unverified address can
occupy index 0, and whether Clerk permits claiming an address no account owns. Those
questions are now **moot** — the code no longer depends on either answer. Resolving an
uncertainty by removing the dependency on it is stronger than resolving it by
investigation, because the investigation's answer could change with a Clerk release.

**Files changed.** `middlewares/authAdmin.js`, `tests/unit_tests.test.js`,
`tests/integration_tests.test.js`.

**Deliberately not changed.** Two other reads of `emailAddresses[0]` exist —
[lib/ensureUser.js:30](lib/ensureUser.js#L30) and
[inngest/functions.js:12,28](inngest/functions.js#L12). Both mirror profile data onto the
`User` row for display; neither makes an authorization decision, and no authorization
path reads `User.email`. They are recorded here so their survival is understood as a
decision rather than an oversight.

**Tests added/changed.** 95 → 101 unit and 194 → 195 integration tests (296 total).

1. **`refuses an unverified primary address`**.
2. **`refuses an admin address the account merely claims but has not proven`** — the
   takeover itself: the configured `ADMIN_EMAIL` sitting unverified at index 0 of an
   attacker's account, alongside their own verified primary.
3. **`grants access when the admin address is primary but not first in the array`** —
   position must not matter *in either direction*; a real admin whose primary sits later
   must still get in. Without this, a fix that simply required index 0 to be verified
   would pass.
4. **`refuses a verified admin address that is not the primary one`** — verification
   alone is not enough.
5. **`fails closed on every malformed verification shape`** — 7 cases including a missing
   record, `expired`, `failed`, `transferable`, and `'VERIFIED'` (matching must be exact).
6. **`fails closed when no primary address is named`** — 4 cases including a primary id
   pointing at nothing.
7. *Integration:* **`every admin endpoint refuses an account that merely claims the admin
   address`** — drives the attack through all 9 admin endpoints, so the guarantee is at
   the API boundary and not only in the helper.

*Changed (two fixtures, no assertion weakened):* the unit and integration Clerk doubles
now model an account as the Backend API actually returns it — addresses with an `id` and
a `verification` record, and a primary named by id rather than implied by position. The
old doubles could not even express the attack, which is why the finding was reachable.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **296 passed** (was 289; +7) |
| Authorization-path audit | `grep` across `app/`, `lib/`, `middlewares/`, `inngest/` confirms `authAdmin` is the only authorization decision derived from an email; `authSeller` uses store status |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) reverting to `emailAddresses[0]` — the original defect — fails 4 tests; (b) resolving the primary correctly but not requiring verification fails 2; (c) accepting *any* verified address rather than the primary fails 3 |

**Residual risk.**

- **Open — admin identity is still an environment variable.** The recommendation's
  longer-term half (Clerk private metadata or a roles table) is **not** implemented.
  `ADMIN_EMAIL` remains a mutable identifier compared at request time, so changing
  administrators still needs a redeploy, and anyone who can set environment variables can
  grant themselves the console. Acknowledged in `docs/ARCHITECTURE.md` as a deliberate
  limitation at one operator; it becomes worth revisiting with a second.
- **Low — dependent on Clerk's `verification.status` semantics.** The check requires the
  exact string `'verified'` and fails closed on anything else, so a new Clerk status
  would deny rather than grant. Safe by direction, but it would need review if Clerk
  changed the field.
- **Unverified against a live tenant.** The Clerk user shape is modelled from the
  Backend API contract, not exercised against a real account. The failure mode of a wrong
  model is a locked-out admin, not an admitted attacker, because every unexpected shape
  returns `false` — verifying it is still worth doing at first deploy (§11).

- **Deployment blocker:** NO — now resolved regardless.

---

### F-13 — No database indexes on any foreign key

- **Status:** ✅ **RESOLVED (structurally)** — 2026-08-11. Seven indexes added by
  migration; three further foreign keys were found to be already covered. **The
  performance benefit itself remains unmeasured** — no database is available to profile
  against (§11.9). See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Performance / scalability
- **Location:** [prisma/schema.prisma](prisma/schema.prisma) (no `@@index`),
  [prisma/migrations/20260725175540_init/migration.sql:140-176](prisma/migrations/20260725175540_init/migration.sql#L140-L176)
- **Evidence:** `grep "INDEX" migration.sql` returns exactly three, all unique
  constraints: `Rating(userId,productId,orderId)`, `Store(userId)`, `Store(username)`.
  Postgres does **not** auto-index FK columns. Unindexed and queried on every request:
  `Order.userId`, `Order.storeId`, `Order.addressId`, `Product.storeId`,
  `OrderItem.productId`, `Rating.userId`, `Rating.productId`, `Address.userId`.
- **Reproduction:** `EXPLAIN ANALYZE SELECT * FROM "Order" WHERE "storeId" = '…'`
  against a seeded database (not run — see §11).
- **Impact:** Every seller dashboard load, every buyer order list, every product page
  is a sequential scan. Fine at seed scale (16 products); degrades linearly and will
  be the first thing to fall over under real traffic, compounded by F-19's N+1-shaped
  unbounded catalogue query. `Order.userId` is also scanned twice per checkout by the
  `forNewUser` coupon check.
- **Root cause:** Schema authored without index annotations.
- **Recommended fix:** Add `@@index([storeId])` on `Product` and `Order`,
  `@@index([userId])` on `Order`, `Address` and `Rating`, `@@index([productId])` on
  `OrderItem` and `Rating`, and generate a migration. Consider a partial index on
  `Order(storeId) WHERE "isPaid"` once F-03/F-04 are fixed.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** Postgres creates an index for a primary key and a unique
constraint, but **not** for a foreign key — a detail that is easy to assume the other
way, and the schema was written on that assumption. The result was that every access
path the application actually uses (a seller's products, a buyer's orders, a store's
orders, a product's ratings) was a sequential scan, and every parent-row delete had to
scan each child table in full to check its constraints.

**Exact remediation.** Seven `@@index` annotations in
[prisma/schema.prisma](prisma/schema.prisma), applied by
[prisma/migrations/20260811130000_index_foreign_keys/migration.sql](prisma/migrations/20260811130000_index_foreign_keys/migration.sql):
`Product.storeId`, `Order.userId`, `Order.storeId`, `Order.addressId`,
`OrderItem.productId`, `Rating.productId`, `Address.userId`.

**A deliberate deviation from the recommendation: three of the ten foreign keys were
left unindexed, because they are already covered.** Postgres can use a multicolumn
btree for a query on a *leading* subset of its columns, so:

| Foreign key | Already led by |
| --- | --- |
| `OrderItem.orderId` | the primary key `(orderId, productId)` |
| `Rating.userId` | the unique constraint `(userId, productId, orderId)` |
| `Store.userId` | its own unique constraint |

The recommendation's `@@index([userId])` on `Rating` would therefore have been a second
index over the same leading column: pure write and storage cost for no read benefit.
Indexing all ten mechanically would have looked more thorough and been worse.

**`Order.addressId` was added although no query filters on it.** It is needed for the
constraint check when an `Address` row is deleted — which happens on the `User` delete
cascade — and without it that check is a sequential scan of `Order`.

**The partial index was not added.** The recommendation suggested
`Order(storeId) WHERE "isPaid"` once F-03/F-04 landed, but the predicate those fixes
settled on is a *disjunction* (`COD OR (STRIPE AND isPaid)`), which a partial index on
`isPaid` alone does not match. A composite such as `(storeId, createdAt)` would likely
serve the seller order list better, but choosing between them without query plans would
be guessing. Left for measurement — see residual risk.

**Files changed.** `prisma/schema.prisma`,
`prisma/migrations/20260811130000_index_foreign_keys/migration.sql` (new),
`tests/unit_tests.test.js`.

**Tests added.** 101 → 104 unit tests (299 total). A `foreign key indexes` block that
parses the **migration SQL** — the DDL actually applied, not the schema's intent — and:

1. **`indexes every foreign key column`** — extracts all ten foreign keys and the
   leading column of every primary key, unique constraint and index, then asserts none
   is uncovered. This is the guard that makes the finding unrepeatable.
2. **`does not add an index that merely duplicates an existing one`** — asserts the
   three covered keys did *not* get a redundant index, and that no index is duplicated,
   so a well-meaning "index all the FKs" change cannot undo the analysis above.
3. **`found the foreign keys and indexes to check`** — asserts the parser matched 10
   foreign keys and ≥10 covering indexes. Without it, a regex that silently matched
   nothing would make both assertions above vacuously true.

**Verification performed.**

| Check | Result |
| --- | --- |
| Schema/migration drift | `prisma migrate diff --from-empty --to-schema-datamodel` produces exactly the seven `CREATE INDEX` statements the migration contains — **diff empty**, so the hand-written SQL matches Prisma's own output and the migrations reproduce the schema |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid 🚀` |
| `npx prisma generate` | Client regenerated cleanly against the new schema |
| Full suite | **299 passed** (was 296; +3) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the migration entirely — the original state — fails with all 7 columns listed; (b) omitting `Order.storeId` fails naming it; (c) adding the redundant `Rating.userId` index fails the duplication test |

**What is *not* verified, plainly.** No `EXPLAIN ANALYZE` was run, no query was timed,
and the migration has never been applied. Docker is unavailable and there is no local
Postgres (§11.1, §11.9), so the evidence here is structural — the right indexes exist,
match Prisma's own DDL, and cover every foreign key — not empirical. The claim being
made is *"the indexes are correctly declared"*, not *"the queries are now fast"*.

**Residual risk.**

- **Open — the performance claim is unmeasured.** §11.9 stays open: profile the seller
  dashboard and buyer order list at ~10k orders, before and after, and confirm the
  planner actually uses these indexes rather than assuming it does.
- **Open — no composite or covering indexes.** The seller order list filters on
  `storeId` plus the payment predicate and sorts by `createdAt`; a `(storeId, createdAt)`
  index would likely serve it better than `(storeId)` alone. Deliberately not guessed
  at without plans.
- **Low — index build locks writes.** `CREATE INDEX` without `CONCURRENTLY` blocks
  writes to each table while it builds, and it cannot be made concurrent here because
  Prisma wraps migrations in a transaction. Negligible at seed scale; on a large live
  table these should be applied out-of-band with `CONCURRENTLY` instead. Noted in the
  migration file itself.
- **Low — write cost.** Seven new indexes make every insert and update to those tables
  slightly more expensive. Correct for a read-dominated storefront, but it is a real
  trade rather than free.
- **Related, still open — F-19.** Indexes do not fix the unbounded catalogue query;
  fetching every product with every rating on every page load remains the larger cost.

- **Deployment blocker:** NO — resolved structurally; the measurement remains outstanding.

---

### F-14 — No health endpoint, no structured logging, no metrics, no error tracking

- **Status:** ⚠️ **PARTIALLY RESOLVED** — 2026-08-11. `GET /api/health` exists and
  answers `503 degraded` with the database down; every failure now emits a structured
  JSON line carrying a correlation id also returned to the caller. **No error tracker
  and no alerting are configured** — those are deployment concerns and remain open. See
  *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Observability / SRE
- **Location:** repository-wide; `app/api/` contains no `health` route
- **Evidence:** `GET /api/health -> 404`. `grep -c "console\."` across `app/ lib/
  middlewares/ inngest/` = **38**, all unstructured `console.log/warn/error`. No Sentry,
  OpenTelemetry, or equivalent in [package.json](package.json). No request ids, no
  correlation between a user-facing toast and a server log line.
- **Reproduction:** `curl /api/health`; `grep -rn "console\." app/ lib/`
- **Impact:** No liveness/readiness probe for uptime monitoring or load-balancer health.
  When F-02 loses a payment, the only trace is an unstructured `console.error` in Vercel's
  log stream with nothing to alert on and no order id attached. Debugging a production
  payment incident would mean manually reconciling against the Stripe dashboard.
- **Root cause:** Observability not in scope during development.
- **Recommended fix:** Add `GET /api/health` returning `{status, db: await prisma.$queryRaw\`SELECT 1\`, version}`.
  Adopt a structured logger with a per-request id. Wire an error tracker. Define alerts on:
  webhook 4xx/5xx rate, orders unpaid > 1h, and `duplicate: true` webhook responses
  (which, per F-02, can indicate lost payments).
- **Deployment blocker:** NO — but the absence of alerting is what turns F-02 from
  recoverable into silent.

#### Resolution — 2026-08-11 (partial)

**Root cause (confirmed).** Observability was never a product of the code, only a
by-product. 38 `console.*` calls emitted prose to a log stream nobody queries, and the
application exposed no way to ask whether it was working. The deeper problem was not the
missing endpoint but that **nothing the application emitted could be counted**: an
incident could only be investigated by reading, never detected by measuring.

**Exact remediation — what is now in the repository.**

1. **[app/api/health/route.js](app/api/health/route.js)** — `GET /api/health`, public and
   uncached, returning `{status, database, version, latencyMs}` with **200** when the
   database answers and **503** when it does not, so a monitor or load balancer can act
   on the status code without parsing a body. Three details are load-bearing:
   `export const dynamic = 'force-dynamic'` (without it Next evaluates the handler at
   build time — a health check answered from the build, and a `next build` that would
   suddenly require a live database); a **5-second timeout** on the probe, because a
   check that hangs is indistinguishable from an app that is down; and `Cache-Control:
   no-store`.
2. **[lib/logger.js](lib/logger.js)** — one JSON object per line, `warn`/`error` to
   stderr so they can be separated at the collector. Fields are always passed
   explicitly; nothing reflects over an object, so a credential cannot arrive by
   accident. `describeError` lifts `name`/`code`/`message`/`stack` out by hand because
   `JSON.stringify(new Error())` is `{}` — a log that says nothing.
3. **[lib/apiError.js](lib/apiError.js)** — every failure now emits an `api_error` event
   **and returns a random `errorId` to the caller**. F-05 deliberately made error
   responses say nothing; this is what keeps them traceable anyway, tying "a shopper
   says checkout failed" to the one log line that explains it. Because F-05 routed all
   31 catch blocks through this one function, adopting the logger there covered every
   error path in the application at once.
4. **Operational events on the money path** — `webhook_processed` (with `markedPaid` and
   the order ids), `webhook_duplicate`, `webhook_session_missing`, `webhook_ignored`,
   and `card_checkout_refused`. These exist specifically so the §13 alerts can be
   written against something: the *"Stripe succeeded-payment count vs application
   paid-order count"* reconciliation is a count of `webhook_processed`, and the
   *"`duplicate: true` not preceded by a success"* alert is a query over
   `webhook_duplicate`.

**Deliberately not done, and why.** The recommendation also asks to *wire an error
tracker* and *define alerts*. Neither is code: an error tracker means adding a
dependency and a DSN that cannot be exercised or verified from here, and alert
definitions live in Vercel or a monitoring product, not in this repository. Adding an
unverifiable SDK to claim the finding closed would be the kind of gesture that looks
like progress and is not. What the repository can own — a probe to watch and events
worth counting — now exists; the watching does not, and the finding stays partially open
because of it.

**Files changed.** `lib/logger.js` (new), `app/api/health/route.js` (new),
`lib/apiError.js`, `app/api/stripe/route.js`, `app/api/orders/route.js`,
`tests/integration_tests.test.js`.

**Tests added.** 195 → 208 integration tests (313 total), in two groups.

*Health (7 tests):* ok with a reachable database; **503 `degraded`** when unreachable;
the failure reason never returned but always logged; `Cache-Control: no-store`;
`dynamic === 'force-dynamic'`; answers without authentication; and **returns exactly the
four documented fields and nothing else**.

*Structured logs (6 tests):* one parseable JSON object per event with a valid timestamp;
the `errorId` in the response matching the log line; a distinct id per failure;
`webhook_processed` emitted with `markedPaid` and order ids; `webhook_duplicate` emitted
on a suppressed replay; `card_checkout_refused` emitted rather than a silent 503; and an
`Error` never logged unlifted.

*Changed (two fixtures):* the F-05 route registry gained `/api/health` — its
exhaustive-by-construction test **caught the new endpoint automatically**, which is that
guard doing its job; and the "still records the full error" test now parses the
structured line instead of comparing to a raw `Error` object, asserting the withheld
detail (`neon.tech`, `P1001`, a stack) is present in the log.

**Verification performed.**

| Check | Result |
| --- | --- |
| **Live probe, database unreachable** | `HTTP/1.1 503 Service Unavailable`, `cache-control: no-store`, body `{"status":"degraded","database":"down","version":"unknown","latencyMs":8}` |
| **Live structured log** | `{"level":"error","event":"health_database_unreachable","time":"2026-08-11T13:21:03.124Z","message":"...Can't reach database server at \`127.0.0.1:5432\`..."}` — the detail withheld from the caller, present for the operator |
| Build | `/api/health` listed as `ƒ` (dynamic), not `○` (static) — confirming it is not prerendered |
| Full suite | **313 passed** (was 299; +14) |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) health always reporting healthy; (b) **health leaking configuration**; (c) removing the correlation id; (d) logging a raw `Error` so it serialises to `{}`; (e) reverting to unstructured lines — each caught |

Mutation (b) initially **passed**: the leak test pattern-matched for known secrets, and
`DATABASE_URL` is unset under test, so the injected field serialised away to nothing.
Pattern-matching only catches the leaks you thought of. Replaced with an assertion that
pins the response to exactly four keys, after which (b) fails. A public, scraped endpoint
should be constrained by shape, not by blocklist.

**Residual risk.**

- **Open — no error tracker.** Failures are logged and correlatable but not aggregated,
  so nobody learns that the same error occurred four hundred times.
- **Open, and the one that matters — no alerting.** Every §13 alert is now *writable*
  against real events, and none is *written*. Until they are, F-02's remaining
  reconciliation gap and F-08's stale-secret case stay silent in exactly the way this
  finding describes. §13 is unchanged and still outstanding.
- **Open — no metrics or tracing.** There is no request duration, throughput or
  saturation signal; `latencyMs` on the health probe is the only timing the application
  produces.
- **Low — six `console.*` calls remain**, in `authAdmin`, `authSeller`, the Stripe
  cleanup path, `store/ai` (which logs the raw model response — noise, and arguably data
  that should not be in logs at all) and two client components. None is on an error path
  that reaches a caller, since those all route through `apiError`.
- **Low — no per-request id.** The correlation id is per *failure*, not per request, so
  two log lines from one request cannot be tied together. Threading a request id would
  mean either passing the request into `apiError` at 31 call sites or reading headers
  inside it; deferred as a larger change than this finding warrants.
- **Unverified — the healthy path.** `200 ok` is proven only against a mocked Prisma;
  the live check ran without a database (§11.1), so only the degraded path has been
  exercised end to end.

- **Deployment blocker:** NO — but the alerting half is still missing, and that is what
  makes the remaining payment risks silent.

---

### F-15 — No security response headers; framework version disclosed

- **Status:** ✅ **RESOLVED**, with one part staged — 2026-08-11. All five headers are
  delivered live and `X-Powered-By` is gone. The CSP **resource** policy ships
  report-only until it can be watched in a browser, so it is not yet defending. See
  *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Security hardening
- **Location:** [next.config.mjs:1-8](next.config.mjs#L1-L8) — no `headers()`, no
  `poweredByHeader: false`
- **Evidence:** `curl -I http://127.0.0.1:3111/` returns `X-Powered-By: Next.js` and no
  `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`,
  `X-Content-Type-Options`, or `Referrer-Policy`.
- **Reproduction:** `curl -I <host>/`
- **Impact:** No clickjacking protection on the checkout and admin pages; no CSP defence
  in depth against the XSS advisories listed in F-01; MIME sniffing permitted; framework
  fingerprint published. Vercel supplies HSTS at the edge, but the rest are absent.
- **Root cause:** Default Next config never hardened.
- **Recommended fix:** Add a `headers()` block with the five headers above and set
  `poweredByHeader: false`.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** The default Next configuration was never hardened. Response
headers are the one security control that costs nothing per request and applies to every
response including error pages and static assets, and none was set — so the storefront
and admin console were framable, the browser was free to sniff content types, full URLs
leaked to third parties by referrer, and every response volunteered the framework.

**Exact remediation** — [next.config.mjs](next.config.mjs):

| Header | Value | Why this value |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Two years, subdomains included. **`preload` deliberately omitted** — it is a one-way commitment enforced by browser vendors, not something to opt into from a config file |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` | `DENY` | Nothing frames this app; checkout and the admin console are what clickjacking would target |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Keeps full URLs, including query strings, off cross-origin requests |
| `Content-Security-Policy` | `frame-ancestors 'none'` | Enforced |
| `Content-Security-Policy-Report-Only` | full resource policy | Staged — see below |
| — | `poweredByHeader: false` | Removes `X-Powered-By: Next.js` |

**The CSP is split deliberately, and this is the part worth scrutinising.** A resource
policy that omits one origin does not degrade — it takes the storefront down. This audit
cannot load the application in a browser against a real Clerk tenant (§11), so enforcing
a policy verified only by reading code would be gambling the site on my own thoroughness.
The split resolves that honestly:

- **`frame-ancestors 'none'` is enforced**, because it carries no breakage risk
  whatsoever: nothing frames this app. That is the clickjacking protection the finding
  asked for, and it is real today.
- **The resource directives ship report-only.** They are derived from the code rather
  than guessed — Clerk's SDK, API, hosted avatars and its Cloudflare Turnstile challenge;
  ImageKit for every product image; `form-action` for the Stripe checkout redirect
  (navigation only, so no `frame-src` for Stripe); `worker-src blob:` because Clerk uses
  web workers. `'unsafe-inline'` for scripts is unavoidable in the App Router without
  nonce plumbing through the render path, and is called out in the file.

**Report-only provides no protection.** It is a staging step, not a fix, and the finding
is only fully closed when it is promoted. Added to §12.

**Files changed.** `next.config.mjs`, `tests/unit_tests.test.js`.

**Tests added.** 104 → 112 unit tests (321 total), asserting against the config's actual
`headers()` output:

1. **`applies to every path`** and **`stops advertising the framework`**.
2. **`sets each of the five headers the audit called for`**.
3. **`does not commit the domain to the HSTS preload list`** — pins the deliberate omission.
4. **`refuses framing in both the modern and the legacy header`**.
5. **`enforces only the directive that cannot break the app`** — asserts the enforced CSP
   is *exactly* `frame-ancestors 'none'`, so the unverified policy cannot be promoted by
   accident rather than by decision.
6. **`allows every origin the app genuinely needs`** — ImageKit, Clerk, Turnstile, Stripe
   checkout, `worker-src blob:`. A missing origin here becomes an outage the day the
   policy is enforced, so it is checked now rather than discovered then.
7. **`keeps the dangerous directives closed`** — `object-src 'none'`, `base-uri 'self'`,
   `default-src 'self'`, no `'unsafe-eval'`, no wildcard script host.

**Verification performed.**

| Check | Result |
| --- | --- |
| **Live headers on a page** | All six delivered: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: frame-ancestors 'none'`, plus the full report-only policy |
| **Live headers on an API route** | Present there too — the rule covers `/:path*`, not just pages |
| **`X-Powered-By`** | **0 occurrences** (previously `X-Powered-By: Next.js`) |
| Full suite | **321 passed** (was 313; +8) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the headers block and `poweredByHeader` — the original state — fails 4 tests; (b) dropping `X-Frame-Options` fails 2; (c) **silently promoting the report-only policy to enforcing** fails 3; (d) dropping the ImageKit origin fails the origin test; (e) adding HSTS `preload` fails its guard |

**Residual risk.**

- **Open — the resource CSP is not enforcing, so it defends nothing yet.** F-01's XSS
  advisories still have no CSP in front of them. Promotion requires loading the app in a
  browser against a real Clerk tenant, confirming the console is free of CSP violations,
  then renaming the header. Added to §12.
- **Known — `'unsafe-inline'` in `script-src` limits what the policy can ever be worth.**
  The App Router emits inline bootstrap and flight-data scripts; removing it needs nonces
  threaded through the render path. The policy still constrains *origins*, which is most
  of the value against script injection from a third-party host, but it is not strict CSP.
- **Low — `includeSubDomains` is a commitment.** Every host serving this must be
  HTTPS-only for two years. True on Vercel; it would need review before pointing a custom
  domain with any plain-HTTP subdomain at it.
- **Low — headers are set by the application, not the edge.** Vercel adds its own HSTS;
  these are belt and braces. A different host or a proxy in front could override them,
  which is worth re-checking against the real deployment (§11.10).

- **Deployment blocker:** NO — now resolved, with the CSP promotion outstanding.

---

### F-16 — Public endpoints expose seller PII and internal identifiers

- **Status:** ✅ **RESOLVED** — 2026-08-11. All six sites now use an explicit `select`.
  Sellers no longer receive buyers' shopping carts, and the public catalogue no longer
  carries seller contact details or Clerk user ids. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Data exposure
- **Location:** [app/api/products/route.js:16](app/api/products/route.js#L16) (`store: true`);
  [app/api/store/data/route.js:15-18](app/api/store/data/route.js#L15-L18);
  [app/api/store/orders/route.js:41](app/api/store/orders/route.js#L41) (`user: true`);
  [app/api/store/dashboard/route.js:22](app/api/store/dashboard/route.js#L22) (`user: true`);
  [app/api/admin/stores/route.js:17](app/api/admin/stores/route.js#L17)
- **Evidence:** Probe P10 shows `include.store === true` with no `select` — the
  unauthenticated catalogue response carries each store's `email`, `contact`, `address`
  and `userId` (the Clerk user id). Probe P3 shows the seller order list includes the
  full buyer `User` row — Clerk id, email, **and the entire `cart` JSONB**, which is
  unrelated to the order being fulfilled.
- **Reproduction:** `curl <host>/api/products | jq '.products[0].store'`
- **Impact:** Seller contact details and Clerk user ids are scrapable by anyone. Sellers
  receive buyers' full current shopping carts — a cross-tenant behavioural data leak with
  no business justification. Exposed Clerk user ids widen the surface for any future
  IDOR.
- **Root cause:** `include: true` used where `select` is needed; no response DTO layer.
- **Recommended fix:** Replace every `include: { store: true }` / `{ user: true }` with an
  explicit `select` listing only the fields the UI renders. Never return `User.cart`
  outside `/api/cart`.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** `include: { user: true }` is a request for *the row*, not for
the fields a screen needs, so what each endpoint returned was decided by the schema
rather than by anyone. Every column added to `User` or `Store` thereafter was published
automatically to whoever could reach the endpoint — which is how a seller's order screen
came to carry each buyer's live shopping cart, and how an unauthenticated, unpaginated
catalogue came to carry every seller's email, phone and Clerk id.

**Exact remediation.** Six call sites, each narrowed to what its screen actually renders,
determined by reading the components rather than guessing:

| Endpoint | Now returns | Previously also carried |
| --- | --- | --- |
| `/api/products` (public) | `store: {name, username, logo}` | seller `email`, `contact`, `address`, `userId`, approval state |
| `/api/store/data` (public) | store `{id, name, description, address, email, logo, username}`, ratings as `{rating}` only | `userId`, `contact`, `status`, `isActive`, and whole `Rating` rows carrying each reviewer's `userId` and `orderId` |
| `/api/store/orders` (seller) | `user: {name, email}` | buyer's Clerk `id`, `image`, and **entire `cart`** |
| `/api/store/dashboard` (seller) | `user: {name, image}`, `product: {id, name, category}` | reviewer's Clerk `id`, `email`, `cart` |
| `/api/admin/stores` | `user: {name, email, image}` | applicant's Clerk `id`, `cart` |
| `/api/admin/approve-store` | `user: {name, email, image}` | as above |

Two judgement calls, both deliberate. **`/api/store/data` still returns the store's
`email`** — the public shop page renders it as the store's contact address, so it is
published by intent rather than by accident; what was removed there is the owner's Clerk
id and the approval state. And **`address: true` on the seller order list is kept**: it
is the buyer's own delivery address, every field of which a packing slip needs.

**Files changed.** `app/api/products/route.js`, `app/api/store/data/route.js`,
`app/api/store/orders/route.js`, `app/api/store/dashboard/route.js`,
`app/api/admin/stores/route.js`, `app/api/admin/approve-store/route.js`,
`tests/integration_tests.test.js`. No component changed — the fields each screen reads
were confirmed first, so the narrowing is invisible to the UI.

**Tests added.** 208 → 215 integration tests (328 total).

The whole suite passed *before* these were added, which is the finding in miniature:
nothing had ever asserted what these endpoints return. So the tests **simulate Prisma
applying the query** — a `project(row, spec)` helper resolves each relation against the
`select` the route actually sent, from a fixture holding the full row including a cart
and a Clerk id. That makes them prove the data stayed behind, not merely that the query
looked right.

1. **`the public catalogue does not carry seller contact details or ids`**.
2. **`the public store page does not carry the owner id or approval state`**.
3. **`a seller never receives a buyer's shopping cart`** — the sharpest part of the
   finding: live behavioural data about a person, on a screen that needs a name to pack
   a parcel.
4. **`the seller dashboard shows a reviewer without their cart or id`**.
5. **Two admin listings** — an admin legitimately sees the applicant's identity, and
   still must not see their cart.
6. **`no endpoint pulls a person or a store in wholesale`** — scans every `route.js` for
   `user: true` / `store: true` so a new endpoint cannot reintroduce the shape, with
   `product: true` and `address: true` deliberately allowed.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **328 passed** (was 321; +7) |
| `npx prisma validate` | Valid — the `select` clauses are legal against the schema |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) reverting the seller list to `user: true` — the original defect — fails 2 tests; (b) reverting the catalogue to `store: true` fails 2; (c) **adding just `contact` back to the catalogue select** fails the PII test; (d) exposing `userId` on the public store page fails its test |

Mutation (c) is the one worth noting: a single extra field slipping into an otherwise
correct `select` is the realistic regression, and it is caught.

**Residual risk.**

- **Low — the guard is textual.** `no endpoint pulls a person or a store in wholesale`
  greps for `user: true` / `store: true`. A relation pulled wholesale by another route —
  say a future `seller: true` — would not be matched. A response-DTO layer would make
  this structural; six endpoints did not justify one.
- **Low — the field lists are point-in-time.** They match what the components render
  today. A screen that starts showing a new field will fail with `undefined` rather than
  silently over-fetching, which is the safer direction, but it does mean the query and
  the component must change together.
- **Informational — F-19 is untouched.** The catalogue payload is smaller now, but it is
  still every product with every rating on every page load, unpaginated.
- **Informational — buyer PII still reaches sellers by design.** Name, email and full
  delivery address are on the fulfilment screen because fulfilment needs them. That is
  the intended boundary; the cart never was.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-17 — Duplicate orders on double-click; no idempotency on checkout

- **Status:** ✅ **RESOLVED** — 2026-08-11. The submit button now has an in-flight
  state, and the endpoint deduplicates on a client-supplied key claimed inside the
  order transaction. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Concurrency / idempotency
- **Location:** [components/OrderSummary.jsx:160](components/OrderSummary.jsx#L160) —
  the Place Order button has no `disabled` state; [app/api/orders/route.js:8](app/api/orders/route.js#L8) —
  `POST` accepts no idempotency key
- **Evidence:** The button's only feedback is `toast.promise`; nothing prevents a second
  click during the in-flight request, and the handler has no server-side dedupe.
- **Reproduction:** Double-click Place Order on a slow connection → two full sets of
  orders and (for Stripe) two Checkout Sessions.
- **Impact:** Duplicate COD orders that sellers will fulfil twice; for Stripe, two
  sessions of which the buyer may pay both. Concurrent requests are unserialised.
- **Root cause:** No submit-in-flight guard, no idempotency key.
- **Recommended fix:** Disable the button while the request is in flight, and accept a
  client-generated `Idempotency-Key` persisted alongside the order for server-side dedupe.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** Checkout had no notion of a *submission*. Each POST was an
independent instruction to create orders, so two identical POSTs meant two baskets — and
nothing anywhere could tell that the second was the first one repeated. Disabling the
button addresses the commonest trigger and none of the others: a retried request, a
second tab, a flaky connection, or anything not driven by that button.

**Exact remediation.**

*Server* — a new `CheckoutRequest` table
([prisma/schema.prisma](prisma/schema.prisma),
[migration](prisma/migrations/20260811140000_checkout_idempotency/migration.sql)) keyed by
an `Idempotency-Key` header, with the flow in
[app/api/orders/route.js](app/api/orders/route.js):

1. **Replay before work.** A key already on file returns the original outcome — the
   stored `sessionUrl` for a card checkout, the success message for COD — without
   touching orders, the transaction or Stripe.
2. **The claim is written inside the order transaction.** This is the F-02 lesson applied
   directly: a claim committed separately could survive a rolled-back basket and make the
   retry replay orders that were never created. Written inside, a key can only ever
   describe orders that exist.
3. **The claim is released by the compensation.** When Stripe session creation fails and
   F-07's cleanup deletes the orders, the claim goes with them — otherwise the retry
   would replay orders that had just been deleted.
4. **A concurrent duplicate resolves to the winner.** Two submissions that both pass the
   pre-check race on the primary key; the loser's transaction rolls back entirely, and
   its request returns what the winner produced instead of an error.

*Client* — [components/OrderSummary.jsx](components/OrderSummary.jsx) gains a `placing`
state that disables the button and relabels it, and sends the key.

**The key identifies the submission, not the click — this is the part that makes it
work.** A key generated inside the click handler would be *different on each click*, so a
double-click would send two keys and deduplicate nothing. It is held in a `useRef` for
the life of the basket and rotated only after an order succeeds, so a second click sends
the same value and the shopper can still deliberately order the same items again later.

**A missing key is accepted rather than rejected.** Requiring it would break checkout for
anyone holding an older cached bundle during a deploy — trading a duplicate-order bug for
an availability one. Without a key the endpoint behaves exactly as before, with no
deduplication; since the shipped client always sends one, that path is for older bundles
and scripted callers.

**Files changed.** `prisma/schema.prisma`,
`prisma/migrations/20260811140000_checkout_idempotency/migration.sql` (new),
`app/api/orders/route.js`, `components/OrderSummary.jsx`,
`tests/integration_tests.test.js`.

**Tests added.** 215 → 226 integration tests (339 total).

1. **`places the order and records the submission on the first request`**.
2. **`creates no second basket when the same submission arrives again`** — the reported
   defect: no `order.create`, no transaction.
3. **`returns the same payment page rather than opening a second one`** — two Stripe
   sessions for one basket is two chances to be charged.
4. **`records the payment page so the replay has something to return`**.
5. **`refuses to guess while the first request is still creating the session`** — 409
   rather than inventing an outcome.
6. **`claims the key in the same transaction as the orders`** — uses the commit marker
   built for F-02.
7. **`leaves no claim behind when the checkout fails`**.
8. **`releases the claim when the stripe session cannot be created`**.
9. **`returns the winner when two identical submissions race`**.
10. **`treats different baskets as different submissions`** — deduplication must not
    prevent a genuine second order.
11. **`still works for a client that sends no key`** — the deployment-safety path.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **339 passed** (was 328; +11) |
| Schema/migration drift | `prisma migrate diff` index output matches the migrations exactly; client regenerates cleanly |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the replay check — the original defect — fails 4 tests; (b) writing the claim outside the transaction fails its ordering test; (c) not releasing the claim when Stripe fails fails its test; (d) making the in-progress Stripe replay guess success fails the 409 test |

**Residual risk.**

- **Low — the client guard is untested.** `placing` and the `useRef` key are correct by
  inspection; there are still no component tests (§10), so the button's disabled state
  and the key's stability across clicks are reasoned about rather than exercised. The
  server-side dedupe is what actually protects the invariant, and that is tested.
- **Low — `CheckoutRequest` rows accumulate.** Nothing prunes them. One row per checkout
  is small, but it grows without bound and deserves a retention policy alongside the
  F-02 reconciliation job.
- **Low — a key is honoured regardless of basket contents.** Reusing a key with different
  items returns the *first* basket's outcome rather than an error. That is standard
  idempotency-key behaviour and the client never does it, but a stricter implementation
  would fingerprint the request body and reject a mismatch.
- **Informational — no expiry.** A key is valid forever, so a submission replayed months
  later still returns the original order. Bounded by the retention policy above.
- **Unverified — the concurrent race.** Modelled through the transaction double; genuine
  simultaneous requests hitting a real Postgres primary key have not been exercised
  (§11).

- **Deployment blocker:** NO — now resolved regardless.

---

### F-18 — Money stored and computed as floating point

- **Status:** ⚠️ **PARTIALLY RESOLVED** — 2026-08-11. All money *arithmetic* is now exact
  integer-cent work behind one shared function used by both the cart summary and the
  checkout, and Stripe is charged the same integers that are persisted. **The columns are
  still `Float`** — investigation showed that is not where the error came from, but the
  recommendation's storage change was not made. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Data integrity / financial correctness
- **Location:** [prisma/schema.prisma:29-30](prisma/schema.prisma#L29-L30),
  [prisma/schema.prisma:57](prisma/schema.prisma#L57) (`Float` → `DOUBLE PRECISION`);
  arithmetic at [app/api/orders/route.js:97-107](app/api/orders/route.js#L97-L107)
- **Evidence:** `parseFloat(total.toFixed(2))` per store, then `fullAmount +=` the
  rounded per-store totals, then `Math.round(fullAmount * 100)` for Stripe. Percentage
  discounts on binary floats compound across stores.
- **Reproduction:** Multi-store basket with a percentage coupon; per-store rounding can
  differ by a cent from the sum the client displayed at
  [components/OrderSummary.jsx:155-156](components/OrderSummary.jsx#L155-L156).
- **Impact:** Cent-level drift between the price shown, the sum of order rows, and the
  amount charged. Accumulates across the ledger; makes reconciliation with Stripe
  imprecise.
- **Root cause:** `Float` chosen for currency.
- **Recommended fix:** Store integer minor units, or `Decimal @db.Decimal(12,2)`. Compute
  the Stripe amount from the persisted order rows rather than a parallel accumulator.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11 (partial)

**Root cause — and the original finding was partly wrong about it.** Before changing
anything I measured where the error actually enters:

```
stored double        : 29.989999999999998437
recovered cents      : 2999          <- Math.round(price * 100) is exact
subtotal formulations disagreeing over 200,000 random baskets: 0
two stores at $10.01, 50% off -> per-store: 1000 cents | whole-basket: 1001 cents
```

`Float` **storage** of an already-rounded two-decimal value is not lossy in any way that
matters: it round-trips to the intended cent every time, and float versus integer
subtotal arithmetic did not disagree once across 200,000 randomised baskets, because the
final `Math.round(× 100)` absorbs the ~1e-16 error.

The real defect was **two implementations of the same calculation**. The cart summary
discounted the whole basket in one step; the server discounted each seller's share and
summed the results. Those genuinely differ — 1000 cents against 1001 on the case above —
so **the price a shopper was shown was not reliably the price they were charged**. The
finding described this as a float-precision problem; it was a duplicated-logic problem
that float arithmetic made harder to reason about.

**Exact remediation.**

1. **[lib/money.js](lib/money.js)** — `toCents`, `fromCents`, `sumCents`,
   `percentOfCents` and a named `SHIPPING_CENTS`. All arithmetic happens in whole cents,
   so results are deterministic rather than dependent on binary representation, and a
   percentage is rounded once at the point it is applied.
2. **[lib/checkoutPricing.js](lib/checkoutPricing.js)** — `priceBasket()`, the single
   definition of what a basket costs: group by seller, discount each share, charge
   shipping once for the basket.
3. **[app/api/orders/route.js](app/api/orders/route.js)** prices through it, and Stripe's
   `unit_amount` is now the **same integer** that produced the persisted order totals —
   the recommendation's second half — instead of a parallel float accumulator
   re-multiplied by 100.
4. **[components/OrderSummary.jsx](components/OrderSummary.jsx)** displays through the
   same function, so the summary and the charge cannot diverge by construction.

**What was deliberately not done, and why.** The columns remain `Float`. Converting to
integer minor units or `Prisma.Decimal` changes the wire format of every price
(`Decimal` serialises to a string; minor units change the magnitude), which means
coordinated edits across roughly fifteen components — with no database to migrate
against and no component tests to catch a mistake. The failure mode of getting that
wrong is *displaying or charging the wrong price*, which is worse than the drift being
fixed, and the measurements above show storage was not contributing error. Recorded as
outstanding rather than quietly dropped.

**Files changed.** `lib/money.js` (new), `lib/checkoutPricing.js` (new),
`app/api/orders/route.js`, `components/OrderSummary.jsx`, `tests/unit_tests.test.js`,
`tests/integration_tests.test.js`.

**Tests added.** 112 → 123 unit and 226 → 229 integration (353 total). Unit tests cover
exact cent recovery, accumulation over 1,000 additions, percentage rounding, non-finite
input, shipping charged once per basket, the zero floor, and a **300-run property test**
asserting a basket always totals exactly the sum of its parts and that every persisted
value round-trips to the same cents. Integration tests assert that Stripe is charged
exactly `round(Σ persisted totals × 100)` — on the $10.01/50% case and across five
awkward price-and-discount combinations.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **353 passed** (was 339; +14) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | Shipping charged per seller, and `toCents` truncating instead of rounding, are both caught. **Reverting to whole-basket discounting — the actual defect — fails 4 tests.** |

**Three mutations did not fail, and they should not have.** Reverting the pricing to
float arithmetic, re-deriving the basket total through currency units, and re-deriving
the Stripe amount the same way all left every test green. Rather than treat that as a
gap and write tests to force a difference, I measured whether one exists: across 200,000
randomised baskets the formulations never disagree. They are **equivalent mutants** —
observably identical for two-decimal prices. Writing a test to distinguish them would
have been testing the implementation rather than the behaviour. The mutation that
corresponds to the real defect does fail, which is the one that matters.

**Residual risk.**

- **Open — the storage change was not made.** `Product.mrp`, `Product.price`,
  `Order.total` and `OrderItem.price` are still `Float`. Measurement says this is not
  currently producing error, but it remains a latent hazard: any future code that does
  currency arithmetic *without* going through `lib/money.js` reintroduces the class. The
  guard is a convention, not a constraint.
- **Low — nothing forces new code through the money module.** There is no test asserting
  that no route performs raw currency arithmetic, as there is for order predicates and
  relation includes. Worth adding if more pricing paths appear.
- **Low — the client display is unverified in a browser.** `OrderSummary` now computes
  through `priceBasket`, proven by unit tests of that function but not by rendering the
  component (§10 — no component tests).
- **Informational — `Coupon.discount` stays a `Float` percentage.** It is a rate, not an
  amount, and it is bounded to `0 < d <= 100` by F-11 and rounded once when applied.

- **Deployment blocker:** NO — the divergence between shown and charged prices is closed;
  the storage change remains outstanding.

---

### F-19 — Unbounded catalogue query; entire product list fetched for every page

- **Status:** ⚠️ **PARTIALLY RESOLVED** — 2026-08-11. The admin dashboard no longer loads
  every order into memory, and the product page fetches its own product by id instead of
  waiting on the whole catalogue (which also fixes the blank-page defect). **The
  catalogue itself is still unpaginated** — that needs coordinated client changes and
  remains open. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Performance / scalability
- **Location:** [app/api/products/route.js:7-19](app/api/products/route.js#L7-L19);
  consumed at [app/(public)/layout.jsx:21-23](app/(public)/layout.jsx#L21-L23)
- **Evidence:** Probe P10 — no `take`, no `skip`, no cursor, plus every `Rating` and the
  full `Store` row joined in. `PublicLayout` dispatches `fetchProducts()` on mount, so
  this fires on the home page, the shop page, every product page and the cart.
  `/api/admin/dashboard` has the same shape ([app/api/admin/dashboard/route.js:19-24](app/api/admin/dashboard/route.js#L19-L24)
  loads every order row into memory to sum them).
- **Reproduction:** `curl <host>/api/products | wc -c` on a populated catalogue.
- **Impact:** Response size and query time grow linearly with the catalogue and its review
  volume, on every page load, with no index (F-13) to help. `/product/[id]` additionally
  cannot render until the whole catalogue arrives — and shows a blank page forever if the
  product is not in the list ([app/(public)/product/[productId]/page.jsx:19-23](app/(public)/product/%5BproductId%5D/page.jsx#L19-L23),
  no not-found state).
- **Root cause:** Client-side filtering of a full dataset rather than server-side queries.
- **Recommended fix:** Paginate `/api/products`; aggregate ratings server-side rather than
  returning every review; add `GET /api/products/[id]`. Replace the admin revenue
  `findMany` with a Prisma `aggregate`.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11 (partial)

**Root cause (confirmed).** Queries were written to fetch *the data*, and the work of
selecting what was actually needed was left to JavaScript afterwards — client-side for
the catalogue, in the route handler for the dashboard. Every screen therefore paid for
the whole table regardless of what it displayed.

**Exact remediation — two of the three recommendations.**

1. **`GET /api/products/[productId]`**
   ([app/api/products/[productId]/route.js](app/api/products/%5BproductId%5D/route.js)),
   with the same visibility rules as the catalogue and the narrowed `store` select from
   F-16. [app/(public)/product/[productId]/page.jsx](app/(public)/product/%5BproductId%5D/page.jsx)
   now fetches through it, which removes that page's dependency on the whole catalogue
   **and fixes the defect named in this finding's Impact**: the page previously searched
   the client-side list and, finding nothing, rendered blank indefinitely. It now tracks
   `loading | found | missing` and says *"This product is no longer available"*.
2. **The admin dashboard sums in the database.**
   [app/api/admin/dashboard/route.js](app/api/admin/dashboard/route.js) uses one
   `aggregate` for revenue and the order count, replacing a `findMany` over every order
   that existed only to be reduced to a single number. The orders-per-day chart still
   needs one row per order, but it is now bounded to the **30 days it displays** and
   selects `createdAt` only — it never read `total`. The chart heading says *"last 30
   days"* so the narrowing is visible rather than silent.

**What was deliberately not done, and why.** `/api/products` is still unpaginated and
still returns every review. Pagination is not a server-side change: the full list is
load-bearing for three other screens — the shop page filters it for search, and both the
cart page and `OrderSummary` resolve products by id out of it. Truncating the list
silently drops items from a shopper's basket and silently removes results from search.
Doing it properly means server-side search and an `ids` lookup for the cart, coordinated
across four components with no component tests to catch a mistake (§10). Aggregating
ratings has the same shape of problem: `ProductDescription` renders individual reviews
and `BestSelling` sorts on `rating.length`, so the array cannot simply become a number.
Both remain open with that plan recorded, rather than half-done.

**Files changed.** `app/api/products/[productId]/route.js` (new),
`app/(public)/product/[productId]/page.jsx`, `app/api/admin/dashboard/route.js`,
`components/OrdersAreaChart.jsx`, `tests/integration_tests.test.js`.

**Tests added.** 229 → 237 integration tests (361 total).

*By-id endpoint (4):* returns one product without touching the catalogue; **404s for a
product that is not purchasable** — the condition that used to render blank forever;
applies the same `inStock` / active-store rules as the catalogue; carries no seller
contact details.

*Admin dashboard (4):* revenue summed via `aggregate` rather than in memory; the chart
query selects `createdAt` only; the chart query is bounded to a window between 29 and 31
days; an empty platform reports `0.00` rather than failing on a `null` sum.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **361 passed** (was 353; +8) |
| Route registry | The F-05 exhaustive guard **caught the new endpoint automatically** and required it to be registered and classified as public |
| `npx next build` | Compiled successfully; `/api/products/[productId]` builds as `ƒ` (dynamic) |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) summing revenue in memory again — the original defect — fails 4 tests; (b) unbounding the chart query; (c) fetching amounts the chart never uses; (d) serving unavailable products by id; (e) returning 200 instead of 404 for a missing product — each caught |

**Residual risk.**

- **Open — `/api/products` is still unpaginated**, and is still fetched on every full page
  load by `app/(public)/layout.jsx`. This is the larger half of the finding. The payload
  is smaller than it was (F-16 removed the full `Store` row from every product), and
  F-13 indexed the columns it filters on, but it still grows linearly with the catalogue.
- **Open — every review still travels with every product.** For a product with hundreds
  of reviews this dominates the response, and `ProductCard` uses them only to compute an
  average.
- **Low — the chart now shows 30 days rather than all history.** A deliberate narrowing,
  labelled in the UI, but it is a behaviour change an operator should know about.
- **Low — one extra request on the product page.** It fetches its own product instead of
  reading the already-loaded list, which is a round trip it did not previously make.
  The trade is that it renders without waiting for the catalogue and can report a missing
  product; the catalogue fetch is unchanged and still populates the other screens.
- **Unverified — no measurement.** As with F-13, there is no database to profile against
  (§11.9), so the improvement is structural: fewer rows requested, bounded windows. No
  timing was taken.

- **Deployment blocker:** NO — the dashboard scan and the blank product page are fixed;
  catalogue pagination remains outstanding.

---

### F-20 — `POST /api/cart` persists arbitrary unvalidated JSON of unbounded size

- **Status:** ✅ **RESOLVED** — 2026-08-11. The audit's own probe now gets
  `400 {"error":"cart quantities must be whole numbers"}` with nothing persisted.
  See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Input validation / resource exhaustion
- **Location:** [app/api/cart/route.js:12-17](app/api/cart/route.js#L12-L17)
- **Evidence:** Probe P8 — a payload with a 1000-character value and arbitrary nesting is
  written verbatim to `User.cart`. No shape check, no size limit, no product-id validation.
- **Reproduction:** `POST /api/cart` with `{"cart": {"x": "<1MB string>"}}` for any
  authenticated user.
- **Impact:** Any authenticated user can inflate their `User` row without limit — cheap
  storage exhaustion against Neon's free tier, and a slow `GET /api/cart` thereafter.
  Non-product keys are silently ignored by the UI, so the abuse is invisible.
- **Root cause:** No validation on the endpoint.
- **Recommended fix:** Validate that `cart` is a flat object of `string → positive integer`,
  cap the key count, and reject ids that do not correspond to products.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** A schemaless column with a schemaless write. `cart` is
`JSONB`, and the handler passed the parsed request body into it unexamined, so what
counted as a cart was whatever the caller said it was. The UI ignores keys it does not
recognise, which is why arbitrary content could sit there indefinitely without anyone
noticing.

**Exact remediation.**

1. **[lib/cartInput.js](lib/cartInput.js)** — a cart is a flat map of product id to
   quantity, and nothing else. Rejects non-objects and arrays; caps the basket at
   **100 distinct products**, quantities at **1–999**, and ids at **64 characters**
   (cuids are ~25). Quantities are *rejected* rather than coerced: a non-integer means
   the caller is not sending a cart, and guessing would write nonsense. It returns a
   freshly built object, so the untrusted one is never what gets persisted.
2. **[app/api/cart/route.js](app/api/cart/route.js)** parses before writing and returns
   **400** with the reason, then checks the surviving ids against `Product` in a single
   query.

**One deliberate departure from the recommendation.** It says to *reject* ids that do not
correspond to products; unknown ids are **dropped** instead, and the write succeeds. A
product can genuinely vanish from under a shopper — a seller deletes it, or its store is
removed — and rejecting the whole write would leave that shopper unable to save their
cart at all, silently, until they worked out which item was poisoning it. Forgetting a
dead item is the better failure. The storage-exhaustion concern is fully addressed either
way, because nothing unknown is written; the drop is logged as
`cart_unknown_products_dropped` so it is visible rather than silent.

**The validation-library decision, as promised.** F-11 deferred the choice of whether to
adopt zod until there were three call sites rather than one. There now are (coupon, cart,
and order status in F-21), and the answer is **no**. The three validators have little in
common — a seven-field object, a map of id to quantity, and an enum member — so a schema
library would mostly replace fifteen lines of explicit code with a dependency and a
different fifteen lines. Against that sits F-01's demonstration of what dependency
surface costs, and the fact that adopting zod now would mean rewriting `lib/couponInput.js`,
which belongs to a finding already closed. The pattern is instead consistent by
convention: a `lib/*Input.js` module per shape, pure, returning `{ value }` or `{ error }`.

**Files changed.** `lib/cartInput.js` (new), `app/api/cart/route.js`,
`tests/unit_tests.test.js`, `tests/integration_tests.test.js`.

**Tests added.** 123 → 132 unit and 237 → 245 integration (378 total).

*Unit (9):* the shape the client actually sends; an empty cart; non-objects and arrays;
**the exact payload the audit stored** (a 1KB string and a nested object); non-positive
and non-integer quantities; the item cap at and just over the limit; the quantity cap;
the id-length cap; and that the returned object is not the caller's.

*Integration (8):* a valid cart persists; the audit's payload is refused with nothing
written; an oversized basket is refused; a missing or non-object cart returns 400 rather
than crashing; unknown ids are dropped while the rest is kept; a cart of only dead ids
still saves as empty; no product query is made for an empty cart; and ids are checked in
**one** query rather than one per item.

**Verification performed.**

| Check | Result |
| --- | --- |
| Audit probe P8 | Before: `persisted cart keys = a,nested  size = 1034`. **After: `arbitrary JSON -> 400 {"error":"cart quantities must be whole numbers"} \| persisted = 0`** |
| Full suite | **378 passed** (was 361; +17) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) writing the body straight through — the original defect — fails 4 tests; (b) removing the item cap fails 2; (c) accepting non-numeric quantities fails 3; (d) persisting unknown ids fails 2 |

**Residual risk.**

- **Low — the request body is unbounded at parse time.** The cap applies after
  `request.json()` has already parsed the payload, so a very large body is still read
  into memory before being rejected. Vercel caps serverless request bodies at ~4.5 MB,
  which is the real control; a self-hosted deployment would want its own limit.
  `Content-Length` is not checked because a client can simply omit it, and doing so would
  give false comfort.
- **Low — one extra query per cart write.** The id check costs a single indexed `IN`
  lookup on every cart sync, which is debounced to at most one per second per shopper.
- **Informational — purchasability is not checked**, only existence. A cart may hold an
  out-of-stock product; the checkout re-validates and refuses it there. Filtering on
  `inStock` here would silently empty carts whenever a seller toggled stock.
- **Informational — the 100-item cap is a judgement.** Far above any real basket, but it
  is a number rather than a derived limit, and a shopper who somehow exceeded it would
  see their cart stop saving with a 400.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-21 — Order status transitions are unvalidated and unordered

- **Status:** ✅ **RESOLVED** — 2026-08-11, in two parts. The missing-`orderId` half was
  closed as a verified side effect of F-03; the enum and state-machine half was closed
  directly today. The probe now reports
  `unknown status -> 400 {"error":"invalid order status"} | prisma touched = 0` and
  `forward-only guard = {"in":["ORDER_PLACED","PROCESSING"]}`. See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Business logic / input validation
- **Location:** [app/api/store/orders/route.js:16-21](app/api/store/orders/route.js#L16-L21)
- **Evidence:** Probe P11 — `{status}` goes straight into `prisma.order.update` with no
  enum check and no state-machine check. Probe P11b — omitting `orderId` yields
  `where: {"storeId":"store_1"}` with the `id` key dropped; Prisma rejects this at runtime
  (no unique field), so it fails as a 400 rather than updating every order in the store —
  but the code relies on Prisma for that safety rather than validating.
- **Reproduction:** probes P11 / P11b.
- **Impact:** A seller can jump an order straight to `DELIVERED`, or move it backwards, at
  any time. No audit trail of transitions. The missing-`orderId` case surfaces a raw
  Prisma error to the caller.
- **Root cause:** No input validation, no state machine.
- **Recommended fix:** Validate `orderId` is a non-empty string and `status` is a member of
  the `OrderStatus` enum; enforce forward-only transitions.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** The handler treated fulfilment state as a value to be *set*
rather than a process to be *advanced*. It accepted whatever `status` arrived and wrote
it, so the column recorded the last thing anyone said rather than how far the order had
actually got. The database enum was the only check, and an enum constrains which values
exist — not which are reachable from where.

**Exact remediation.**

1. **[lib/orderStatus.js](lib/orderStatus.js)** — `ORDER_STATUS_SEQUENCE` names the four
   stages in order, and `parseOrderStatus` returns the requested status together with
   **every status it may be reached from**.
2. **[app/api/store/orders/route.js](app/api/store/orders/route.js)** rejects an unknown
   status with 400, then applies the direction rule **inside the `where` clause** —
   `status: { in: reachableFrom }` — alongside the ownership and payment guards. A
   backwards transition simply matches no row.

**Applied in the update, not by reading first.** A read-then-compare-then-write would
leave a window in which two concurrent updates both pass their check and the later one
wins regardless of direction. Because the reachable set is derivable from the target
alone, the whole rule fits in the statement that does the write — the same approach F-03
took for the payment guard. A read *does* happen when nothing matched, but only on the
failure path, to distinguish "not your order" (404) from "that would move it backwards"
(409). At that point there is nothing left to race.

**Skipping ahead is allowed; going backwards is not.** A seller who packs and ships in
one action should not have to click through `PROCESSING` first, so `reachableFrom` is
inclusive of every earlier stage. It also includes the target itself, so re-sending the
current status is a harmless no-op rather than an error a double-clicked dropdown would
produce.

**The audit trail, proportionately.** The finding notes there is no record of
transitions. The row only ever holds the latest value, so each successful change now
emits an `order_status_changed` event through the F-14 logger, carrying the order, the
store and the new status. That is a searchable history without a schema change; a durable
table remains the option if disputes ever need one.

**Files changed.** `lib/orderStatus.js` (new), `app/api/store/orders/route.js`,
`tests/unit_tests.test.js`, `tests/integration_tests.test.js`.

**Tests added.** 132 → 139 unit and 245 → 252 integration (392 total).

*Unit (7):* **the sequence covers exactly the statuses the schema defines** — if a stage
is added to the enum and forgotten here its rank is `-1` and it becomes silently
unreachable, so this fails loudly instead; every real status parses; non-statuses,
lowercase, empty and non-strings are refused; the reachable set for two targets; the
property that **nothing may move backwards**, checked across every pair; re-sending the
current status is reachable; skipping ahead is permitted.

*Integration (7):* an order advances and the transition is logged; seven invalid statuses
are refused with nothing written; **the direction is enforced in the `where`, with no
preceding read**; a delivered order cannot move back (409, naming both states); an order
that is not the seller's still returns 404 so the two failure modes stay distinguishable;
skipping ahead works; and the ownership and payment guards are still present alongside
the new one.

*Changed (one fixture):* the F-03 test for an unpaid Stripe order now states explicitly
that the diagnostic read finds nothing. It had been passing on a leftover mock
implementation from an unrelated test — `vi.clearAllMocks()` clears calls but not
implementations — which the new failure path exposed.

**Verification performed.**

| Check | Result |
| --- | --- |
| Audit probe P11a | Before: `status value reaching Prisma = {"status":"DELIVERED"}` with no validation. **After: `unknown status -> 400 {"error":"invalid order status"} \| prisma touched = 0`**, and `forward-only guard = {"in":["ORDER_PLACED","PROCESSING"]}` |
| Audit probe P11b | `missing orderId -> 400 ... \| prisma touched = 0` — still closed |
| Full suite | **392 passed** (was 378; +14) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) writing the status unvalidated — the original defect — fails 4 tests; (b) removing the forward-only guard fails 2; (c) making every status reachable from every other fails 3; (d) dropping a stage from the sequence fails 4; (e) **enforcing direction by a separate read instead of in the update** fails 4 |

**Residual risk.**

- **Low — no durable audit trail.** Transitions are in the log stream, not the database,
  so retention is whatever the log platform keeps and they cannot be queried alongside
  the order. Sufficient for operations; a dispute needing history months later would
  want a table.
- **Low — `DELIVERED` is terminal by omission.** Nothing can move past it, which is
  correct, but there is no cancellation or return path in the model at all. An order
  that needs unwinding has no representation, which is a product gap rather than a defect.
- **Informational — the seller UI still offers every status in a dropdown.** A backwards
  selection now returns a clear 409 rather than silently corrupting the row, but the
  option is still presented. Disabling unreachable options would be the tidier finish.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-22 — Ratings do not require payment or delivery; coupons have no redemption limit

- **Status:** ✅ **RESOLVED** — 2026-08-11. A review now requires a delivered, placed
  order (`P9 undelivered order -> 404 ... | review written = 0`), and a coupon is limited
  to one use per shopper with an optional platform-wide cap. See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Business logic
- **Location:** [app/api/rating/route.js:19-25](app/api/rating/route.js#L19-L25);
  [app/api/orders/route.js:42-64](app/api/orders/route.js#L42-L64)
- **Evidence:** Probe P9 — `where: {"id":"o1","userId":"u1","orderItems":{"some":{"productId":"p1"}}}`,
  no `isPaid` and no `status` predicate; an unpaid, just-placed COD order returns 200.
  For coupons, the only usage constraint is `forNewUser` (checked by counting orders) and
  `forMember`; there is no per-user redemption ledger and no global cap.
- **Reproduction:** probe P9; for coupons, apply the same code to unlimited consecutive orders.
- **Impact:** Review integrity — a user can place a COD order and immediately post a review
  without ever receiving or paying for the product. Coupon economics — a public percentage
  coupon can be redeemed indefinitely by the same account.
- **Root cause:** Purchase verification defined as "an order exists" rather than "a
  fulfilled order exists"; no redemption tracking model.
- **Recommended fix:** Require `status === 'DELIVERED'` (and paid, for Stripe) before
  rating. Add a `CouponRedemption` table with a unique constraint per user/coupon and a
  global usage cap.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** Both halves are the same mistake: a rule that existed in the
interface but never in the data layer. The orders screen already hid *"Rate Product"*
behind `order.status !== "DELIVERED"`, and coupons were plainly intended to be a limited
promotion — but neither was expressed anywhere the server could enforce it, so both held
only for as long as everyone used the UI.

**Exact remediation — reviews.** [app/api/rating/route.js](app/api/rating/route.js) now
requires `status: DELIVERED` **and** the shared `PLACED_ORDER` predicate, alongside the
existing ownership and line-item match. The message changed from *"Order not found"* to
*"You can review a product once its order has been delivered"*, which is the actual
reason. No UI change was needed: the button was already hidden, so this only closes the
direct-API path.

**Exact remediation — coupons, and a departure from the recommendation.** The
recommendation asks for a `CouponRedemption` table with a unique constraint. I did not
build one, because a separate ledger would need **release semantics** that nothing else
in the system requires: a coupon consumed when a Stripe order is created has to be given
back when the session fails, when the buyer abandons the checkout, and when the
`payment_intent.canceled` webhook deletes the orders — three places that must be kept in
step forever, and the exact class of bug F-02 was about.

Instead, redemption is **derived from orders that actually stand**:

- `Order.couponCode` is a new nullable column, recording the code alongside the existing
  JSON snapshot. A snapshot is not queryable; a column is, and it is indexed.
- *One per shopper*: `findFirst({ userId, couponCode, ...PLACED_ORDER })`.
- *Platform-wide*: `count({ couponCode, ...PLACED_ORDER })` against the new optional
  `Coupon.maxRedemptions`.

Because `PLACED_ORDER` already excludes an unpaid Stripe order and cancellation already
deletes one, an abandoned checkout **never burns the shopper's coupon** and nothing has
to release anything. One source of truth, no reconciliation.

`maxRedemptions` is settable: `parseCouponInput` accepts it (blank means unlimited,
otherwise a whole number ≥ 1) and the admin coupon form has a *"Total redemption limit
(optional)"* field. A cap with no way to set it would have been decoration.

**Files changed.** `prisma/schema.prisma`,
`prisma/migrations/20260811150000_coupon_redemption_limits/migration.sql` (new),
`app/api/rating/route.js`, `app/api/orders/route.js`, `lib/couponInput.js`,
`app/admin/coupons/page.jsx`, `tests/unit_tests.test.js`,
`tests/integration_tests.test.js`.

**Migration.** Two nullable additive columns and one index; the previous release runs
unchanged against it. Existing orders keep `couponCode = NULL`, so a coupon used before
the migration is not counted against its cap — stated here because it is a deliberate
choice, not an oversight.

**Tests added.** 139 → 144 unit and 252 → 261 integration (405 total).

*Reviews (2):* the query requires `DELIVERED` and the placed-order predicate; an
undelivered order is refused with a message that says why, and no review is written.

*Coupons (8):* the code is recorded on the order; a second use by the same shopper is
refused; **redemption counts only orders that stand** (so an abandoned checkout does not
burn it); a platform-wide cap is enforced; the redemption that *reaches* the cap is still
allowed (an off-by-one that would silently lose the last sale); no count query runs when
no cap is set; a zero cap means exhausted rather than unlimited; an uncouponed order is
untouched.

*Unit (3):* absent, blank and null redemption limits mean unlimited; a limit is accepted
as a number or a form string; a non-positive or fractional limit is refused.

*Changed (2 assertions):* the coupon column allowlist now expects eight columns rather
than seven, the schema having legitimately gained one.

**Verification performed.**

| Check | Result |
| --- | --- |
| Audit probe P9 | Before: an unpaid `ORDER_PLACED` order returned **200** and published a review. **After: `undelivered order -> 404 {"error":"You can review a product once its order has been delivered"} \| review written = 0`**, with `status: "DELIVERED"` visible in the query |
| Schema/migration drift | `prisma migrate diff` index output matches the migrations exactly; client regenerates cleanly |
| Full suite | **405 passed** (was 392; +13) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing the review gate — the original defect; (b) removing the per-shopper check; (c) ignoring the platform-wide cap; (d) **counting abandoned checkouts as redemptions**; (e) not recording the code on the order — each caught |

**Residual risk.**

- **Low — the redemption check is read-then-write.** Two simultaneous checkouts by the
  same shopper with the same coupon could both pass the `findFirst` and both commit.
  Unlike the F-17 and F-21 guards, this one cannot move into the `where` of the write,
  because it queries a *different* row than the one being created. A unique index on
  `(userId, couponCode)` would close it, but it would also forbid a legitimate second
  order after a refund, and the exposure — one extra discount, requiring deliberate
  timing — did not justify that. F-17's idempotency key already blocks the accidental
  version.
- **Low — the platform-wide cap has the same race**, with a wider window under
  concurrency. A cap of 100 might yield 101 under a burst. Acceptable for a promotional
  limit; a hard financial limit would need a counter row updated in the transaction.
- **Informational — historical coupon use is not counted.** Orders placed before this
  migration have no `couponCode`, so an existing coupon starts from zero.
- **Informational — reviews still do not require the *reviewer* to have received the
  item**, only that the order reached `DELIVERED`, which a seller sets. That is the
  strongest signal the model has; nothing tracks actual receipt.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-23 — Rejected stores keep selling; catalogue and checkout disagree on eligibility

- **Status:** ✅ **RESOLVED** — 2026-08-11. All four public reads now share one
  `SELLABLE_STORE` predicate, and rejection switches the store off as well as marking it.
  See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Business logic / consistency
- **Location:** [app/api/admin/approve-store/route.js:23-27](app/api/admin/approve-store/route.js#L23-L27)
  (rejection does not clear `isActive`); [app/api/products/route.js:8](app/api/products/route.js#L8)
  (filters `isActive` only) vs [app/api/orders/route.js:69-75](app/api/orders/route.js#L69-L75)
  (filters `isActive` **and** `status: 'approved'`)
- **Evidence:** Probe P10 — catalogue `where` is `{"inStock":true,"store":{"isActive":true}}`.
  Rejecting a previously approved store sets `status: 'rejected'` but leaves `isActive: true`.
  `/api/store/data` likewise checks `isActive` only.
- **Reproduction:** Approve a store, add a product, reject the store. The product remains
  visible in the storefront and on the store page, but adding it to a basket fails checkout
  with `"product is unavailable"`.
- **Impact:** A rejected seller's products stay listed and clickable but cannot be bought —
  a dead end at the last step of the funnel with an unhelpful error.
- **Root cause:** Two different definitions of "sellable" across three endpoints.
- **Recommended fix:** Set `isActive: false` on rejection, and apply the same
  `{isActive: true, status: 'approved'}` predicate in all three places via a shared constant.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** *"Can this store sell?"* was two independent facts —
`status`, the administrator's decision on the application, and `isActive`, whether the
store is currently switched on — with no single expression of how they combine. Each
query answered the question for itself: the catalogue and the public store page checked
only `isActive`, checkout checked both. Rejection then compounded it by recording the
decision without acting on it, leaving `isActive` untouched on a store that had already
been approved and activated. This is the same shape as F-03: a business rule that existed
only as literals, duplicated until they disagreed.

**Exact remediation.**

1. **[lib/sellableStore.js](lib/sellableStore.js)** — `SELLABLE_STORE`, one definition of
   what makes a store's goods visible and buyable.
2. Applied to all four public reads: the catalogue
   ([app/api/products/route.js](app/api/products/route.js)), the by-id endpoint
   ([app/api/products/[productId]/route.js](app/api/products/%5BproductId%5D/route.js)),
   the public store page ([app/api/store/data/route.js](app/api/store/data/route.js)) and
   checkout ([app/api/orders/route.js](app/api/orders/route.js)).
3. **Rejection now switches the store off**
   ([app/api/admin/approve-store/route.js](app/api/admin/approve-store/route.js)):
   `{ status: "rejected", isActive: false }`.

**A finding I introduced and then closed.** The by-id endpoint added under **F-19** was
not in the original audit — it did not exist when the report was written. I gave it
`store: { isActive: true }`, copied from the catalogue, and so it inherited exactly this
defect on the day it was created. That is the argument for the shared constant rather
than a careful copy: I made the mistake this finding describes while fixing a different
one, four findings after documenting it.

**Files changed.** `lib/sellableStore.js` (new), `app/api/products/route.js`,
`app/api/products/[productId]/route.js`, `app/api/store/data/route.js`,
`app/api/orders/route.js`, `app/api/admin/approve-store/route.js`,
`tests/integration_tests.test.js`. No schema change: both columns already existed and the
data is consistent — a rejected store simply keeps a stale `isActive` until an
administrator toggles it, which the fix prevents going forward.

**Tests added.** 261 → 266 integration tests (410 total).

1. **`every public read applies the same store predicate as checkout`** — drives all four
   endpoints and asserts each uses `SELLABLE_STORE`, with per-endpoint failure messages,
   then asserts the catalogue and checkout predicates are **equal**: a shopper must never
   reach a product they will be refused at the till.
2. **`requires approval, not merely being switched on`** — pins the meaning itself.
3. **`no route decides store eligibility on its own`** — scans every `route.js` for an
   inline `isActive: true`, with the two admin routes that legitimately *write* the flag
   named explicitly rather than matched loosely.
4. **`rejection takes a live store off the storefront`** and **`approval still switches a
   store on`** — both directions of the administrator's decision.

*Changed (5 assertions):* tests that asserted the old, incomplete predicate — including
one literally named *"rejecting a store does not activate it"* — now assert the shared
one. Those assertions had encoded the defect: they passed precisely because the catalogue
checked less than checkout did.

**Verification performed.**

| Check | Result |
| --- | --- |
| Source scan | `grep -rn "isActive: true" app/api` returns only the approval route, which *sets* the flag |
| Full suite | **410 passed** (was 405; +5) |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) the catalogue re-forking its own predicate — the original defect — fails 4 tests; (b) rejection no longer deactivating fails 2; (c) dropping `status` from the shared predicate fails 2; (d) the store page re-forking fails 3 |

**Residual risk.**

- **Informational — existing rejected-but-active stores are not repaired.** The migration
  is behavioural, not data: a store rejected before this change keeps `isActive: true`
  until an administrator toggles it. A one-line `UPDATE "Store" SET "isActive" = false
  WHERE status = 'rejected'` would clean it up; not run here because there is no database
  to run it against (§11).
- **Low — `authSeller` checks `status` but not `isActive`.** A seller whose store has been
  deactivated retains their dashboard and can still add products, which then stay hidden
  from the storefront. Arguably correct — they should see their own orders — but it is a
  third definition of "this store is operating", and the audit did not flag it.
- **Low — the guard is textual**, like F-16's. A future eligibility check written as
  `status: 'approved'` alone, without `isActive`, would not be matched.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-24 — `.gitignore` does not cover `.env.local` or `.env.production`

- **Status:** ✅ **RESOLVED** — 2026-08-11. All six env variants are now ignored and the
  checked-in template is still tracked, verified by asking git rather than by reading the
  file. See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Secrets management
- **Location:** [.gitignore:29-30](.gitignore#L29-L30) — ignores `.env` only
- **Evidence:** `.env.local`, `.env.development.local`, `.env.production` and `.env*.local`
  are all untracked-but-not-ignored. Next.js's own convention is `.env.local`. Scans of
  the full git history (9 commits) found **no** committed secrets — the current state is clean.
- **Reproduction:** `touch .env.local && git status` → shows as untracked, not ignored.
- **Impact:** A developer following the Next.js convention rather than this project's README
  can commit live credentials.
- **Root cause:** Incomplete ignore pattern.
- **Recommended fix:** Replace with `.env*` plus `!.env.example`.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** The ignore rule named one filename rather than describing the
category of file. `.env` was listed; `.env.local` — which is *Next.js's own convention*,
and the name a developer following the framework's documentation would reach for first —
was not, along with every other variant. The protection depended on the developer
choosing the same filename the rule's author happened to think of.

Measured before the change:

```
IGNORED      .env
not ignored  .env.local
not ignored  .env.production
not ignored  .env.development.local
not ignored  .env.production.local
not ignored  .env.test.local
```

**Exact remediation.** [.gitignore](.gitignore) now uses `.env*` with `!.env.example`
below it, so every variant is ignored and the checked-in template stays visible. The
comment records that the negation must remain below the pattern it exempts, because
gitignore is order-sensitive and the failure is silent in the direction that matters.

**Files changed.** `.gitignore`, `tests/unit_tests.test.js`. The git history was
re-scanned during the original audit and contains no committed secrets, so there is
nothing to purge — this closes the door before anything walked through it.

**Tests added.** 142 → 146 unit tests (414 total). They ask **git** rather than reading
the file's text, because pattern order and negations make the effective rule non-obvious:

1. **`can ask git the question at all`** — asserts `git rev-parse` succeeds. Without it,
   a git that failed to run would make every assertion below report "not ignored" and the
   suite would stay green.
2. **`ignores every env file that could hold a live credential`** — all six variants,
   each named in the failure message.
3. **`keeps the checked-in template visible`**.
4. **`still tracks the template`**.

**Verification performed.**

| Check | Result |
| --- | --- |
| `git check-ignore` sweep | All six variants **IGNORED**; `.env.example` **not ignored** |
| Live check | A real `.env.local` containing `CLERK_SECRET_KEY=sk_live_...` produces **0** entries in `git status` |
| Nothing untracked by accident | `git status` shows no files deleted from the index |
| Full suite | **414 passed** (was 410; +4) |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) reverting to `.env` alone — the original state; (b) **removing the template exemption**; (c) **ordering the negation before the pattern** — each caught |

**A test that proved nothing, and how it was found.** Mutations (b) and (c) initially
**passed**. The cause was in my test, not the fix: `git check-ignore` without
`--no-index` reports any *tracked* file as not-ignored regardless of the rules, and
`.env.example` is tracked — so the assertion succeeded because the file was committed,
not because the negation worked. Verified directly: with the negation deleted,
`check-ignore` says "not ignored" and `check-ignore --no-index` says "IGNORED". Adding
`--no-index` makes the test evaluate the ignore rules themselves, after which both
mutations fail. Worth recording because the test read as obviously correct and was
completely hollow.

**Residual risk.**

- **Informational — this prevents, it does not detect.** Nothing stops a developer using
  `git add -f`, and nothing scans commits for credential-shaped strings. A secret-scanning
  hook or GitHub's push protection would be the detective half; the audit did not ask for
  one and none is configured.
- **Informational — only env files are covered.** Other credential-bearing files — a
  service-account JSON, a `.pem` (already ignored), a database dump — are not addressed by
  this pattern.
- **Low — the tests require git.** They run inside a work tree, which CI provides via
  `actions/checkout`, and the first test fails loudly if git is unavailable rather than
  silently passing.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-25 — Node version drift between `.nvmrc`, CI and the local toolchain

- **Status:** ✅ **RESOLVED** — 2026-08-11. `engines: {"node": "22.x"}` declares the
  supported range, `.npmrc` makes it enforced rather than advisory, and the three sources
  are pinned to agree by test. See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Build reproducibility
- **Location:** [.nvmrc](.nvmrc) (`22`), [.github/workflows/ci.yml:16](.github/workflows/ci.yml#L16)
  (`node-version-file: .nvmrc`), [package.json](package.json) (no `engines` field)
- **Evidence:** This audit ran on Node **v25.2.1**; CI runs 22. Vercel selects its own
  default unless configured. Nothing pins the runtime for the deployed application.
- **Impact:** Build and runtime can differ across three environments; `engines` would fail
  the install loudly instead.
- **Recommended fix:** Add `"engines": {"node": ">=22 <23"}` to `package.json` and pin the
  Vercel Node version.
- **Deployment blocker:** NO

#### Resolution — 2026-08-11

**Root cause (confirmed).** The supported Node version was expressed in a file that only
one of the three consumers reads. CI followed `.nvmrc`; Vercel does not read `.nvmrc` at
all and chose its own default; a developer's machine was unconstrained. Three answers to
one question, with nothing comparing them and nothing failing when they differed — the
audit itself ran on **Node v25.2.1** against a project pinned to 22 and every command
succeeded.

**Exact remediation.**

1. **[package.json](package.json)** — `"engines": {"node": "22.x"}`. This is also the
   documented way to pin **Vercel's** build runtime, so it closes the half of the
   recommendation that is otherwise a dashboard setting nobody can see from the repository.
2. **[.npmrc](.npmrc)** (new) — `engine-strict=true`.

**The second file is the one that matters, and the recommendation understates it.** The
report said `engines` "would fail the install loudly instead". On its own it would not:
npm prints `EBADENGINE` and **installs anyway**. Declaring a range that nothing enforces
would have reproduced the finding's own root cause — a statement of intent that no
consumer acts on. `engine-strict=true` is what turns it into a rule.

`22.x` rather than the suggested `>=22 <23`: identical in effect, and it reads as "the
major this project targets", matching `.nvmrc` exactly.

**Files changed.** `package.json`, `.npmrc` (new), `tests/unit_tests.test.js`.

**Tests added.** 146 → 150 unit tests (418 total). They compare the sources to each other,
because the defect was disagreement rather than any single wrong value:

1. **`declares a Node range at all`** — without it, Vercel silently picks its own default.
2. **`agrees with .nvmrc on the major version`** — the two must not drift apart.
3. **`makes the range a rule rather than advice`** — asserts `engine-strict=true`, so the
   enforcement cannot be dropped while the declaration stays and looks fine.
4. **`has CI follow .nvmrc rather than its own hardcoded version`** — asserts the workflow
   uses `node-version-file` and contains no pinned `node-version:`.

**Verification performed.**

| Check | Result |
| --- | --- |
| **Enforcement is real** | `npm install` on this machine now exits **1**: `npm error code EBADENGINE ... Required: {"node":"22.x"}` |
| Range accepts what it should | 22.0.0, 22.11.0, 22.20.0 install; 20.18.0, 24.0.0 and 25.2.1 are refused |
| CI unaffected | CI installs Node 22 from `.nvmrc`, which satisfies the range |
| Full suite | **418 passed** (was 414; +4) — `node_modules` already present, so the suite is unaffected by the install gate |
| `npx next build` | Compiled successfully, 41/41 static pages |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) removing `engines` — the original state — fails 2 tests; (b) `engines` disagreeing with `.nvmrc`; (c) removing `engine-strict`; (d) CI hardcoding its own version — each caught |

**Residual risk.**

- **Known, and it is the finding — this machine no longer satisfies the range.** Running
  Node v25.2.1, `npm install` here now fails by design. That is the drift being reported,
  surfaced rather than tolerated. All remediation from F-01 onward was verified on this
  toolchain, including a clean `npm ci` under F-01 **before** the constraint existed; the
  suite and build continue to run because `node_modules` is already installed. A
  contributor on the wrong major must switch (`nvm use`) rather than discover the
  difference later in production.
- **Low — `22.x` is stricter than the application needs.** Next 15 supports Node 18.18+,
  so a contributor on 20 or 24 is refused an install for a version that would very likely
  work. Deliberate: the point is one declared target, and widening the range reintroduces
  the ambiguity.
- **Informational — Vercel's runtime is inferred, not asserted.** `engines.node` is the
  documented mechanism, but nothing here proves Vercel honoured it. Worth confirming in
  the build log at first deploy (§11.11).
- **Informational — the npm version is unconstrained.** Only Node is pinned; a different
  npm major could still resolve the lockfile differently.

- **Deployment blocker:** NO — now resolved regardless.

---

### F-26 — `prisma migrate deploy` runs inside the build step

- **Status:** ✅ **RESOLVED** — 2026-08-11. The build no longer touches the database
  (verified: `npm run build` now succeeds with no `DATABASE_URL` at all), migration is a
  gated workflow, additive-only is enforced by test, and the rollback procedure is
  written down. See *Resolution* at the end.
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** Deployment / rollback
- **Location:** [package.json:8](package.json#L8) — `"build": "prisma generate && prisma migrate deploy && next build"`
- **Evidence:** Migrations execute during the Vercel build, before the new deployment is
  live and while the old one still serves traffic.
- **Impact:** Schema changes land while the previous version is running, so any non-additive
  migration breaks production during the build window. Concurrent builds (two pushes in
  quick succession) race on the migration lock. Rolling a deployment back does **not** roll
  the schema back, and there are no down migrations — recovery from a bad migration is manual.
- **Recommended fix:** Move migrations to an explicit, gated release step separate from the
  build. Require additive-only (expand/contract) migrations so old and new code can both run
  against the intermediate schema. Document a rollback procedure and take a Neon branch
  snapshot before each release.
- **Deployment blocker:** NO — but the rollback story must be written down before launch.

#### Resolution — 2026-08-11

**Root cause (confirmed).** Two operations with different risk, different timing and
different reversibility were welded into one command. Compiling is idempotent, reversible
by redeploying, and touches nothing shared; migrating is none of those. Chaining them
meant the schema changed as a *side effect of shipping* — while the previous version was
still serving traffic, with two concurrent builds racing for the same advisory lock, and
with a rollback that returned the code but not the database.

**Exact remediation — all four parts of the recommendation.**

1. **Separated.** [package.json](package.json): `build` is now
   `prisma generate && next build`. New `migrate:deploy` and `migrate:status` scripts make
   applying a migration its own act.
2. **Gated.** [.github/workflows/migrate.yml](.github/workflows/migrate.yml) — a
   `workflow_dispatch` job that requires the operator to type `migrate` to confirm, runs
   under a `production` environment (so credentials can require review), and **prints the
   pending list before applying and the settled state after**. Applying a migration is now
   something a person does and Actions records.
3. **Additive-only, enforced.** A test rejects any migration containing `DROP TABLE`,
   `DROP COLUMN`, a rename, `SET NOT NULL` or an `ALTER COLUMN ... TYPE`, and any
   `ADD COLUMN ... NOT NULL` without a `DEFAULT`. A deliberate contract phase can opt out
   with an `-- expand-contract:` note explaining the plan — verified to work, so the
   escape hatch is real rather than theoretical.
4. **Rollback written down.** A new *Releases* section in [README.md](README.md):
   snapshot the Neon branch, migrate, then deploy — and to roll back, redeploy the previous
   commit (the schema stays, which is harmless *because* migrations are additive) or
   restore the Neon branch. It states plainly that there are no down migrations.

**Why the order is safe, and why point 3 is what makes it so.** Migrating before deploying
means the old code runs against the new schema for the length of the deploy. That is only
acceptable while every migration is additive — which was previously a hope and is now a
test. The two are a pair: separating the steps without enforcing additive-only would have
traded one failure mode for a worse one.

**A stale comment corrected.** CI's build step called `npx next build` directly, with a
comment explaining it was skipping the migration in the npm script. That reason no longer
exists, so CI now runs `npm run build` — exercising exactly what a deploy runs, rather
than an approximation of it.

**Files changed.** `package.json`, `.github/workflows/migrate.yml` (new),
`.github/workflows/ci.yml`, `README.md`, `tests/unit_tests.test.js`.

**Tests added.** 150 → 156 unit tests (424 total).

*Migration safety (3):* the migrations were actually found — without this a wrong path
would make the rest vacuous; nothing destructive is present; no `NOT NULL` column arrives
without a default, which would fail outright on a non-empty table.

*Build separation (3):* the build script contains no `migrate`; it still runs
`prisma generate`; and both migration scripts exist as their own steps.

**Verification performed.**

| Check | Result |
| --- | --- |
| **The build no longer needs a database** | `env -u DATABASE_URL -u DIRECT_URL npm run build` → `✔ Generated Prisma Client` then `✓ Compiled successfully`. Previously this command required a live database |
| Workflow well-formed | All keys the runner requires are present; no tabs |
| Full suite | **424 passed** (was 418; +6) |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) migration back inside the build — the original defect; (b) a `DROP COLUMN` migration; (c) a `SET NOT NULL` migration; (d) a `NOT NULL` column with no default — each caught. **Control:** the same `DROP COLUMN` *with* an `-- expand-contract:` note passes, confirming the opt-out works |

**Residual risk.**

- **Open, and the real trade this makes — a forgotten migration is now possible.** Coupling
  guaranteed migrations were applied; separating them means a deploy can ship code whose
  schema is not there, surfacing as `relation does not exist`. That was the coupling's one
  virtue and it is gone. Mitigated by documentation and by `migrate:status`, not by
  machinery: nothing blocks a deploy whose migrations are pending. A pre-deploy check
  calling `migrate:status` and failing on drift would close it, and is the natural next
  step.
- **Low — the gated workflow is unexercised.** It has never run: it needs `DATABASE_URL`
  and `DIRECT_URL` secrets and a `production` environment that do not exist yet, and there
  is no database to apply anything to (§11.1). Its structure is verified; its execution is
  not.
- **Low — the additive-only check is textual.** It reads SQL with regular expressions, so
  an unusual formulation could slip past, and it cannot judge whether an `-- expand-contract:`
  note is honest. It raises the floor rather than proving safety.
- **Informational — still no down migrations.** Reversal means restoring a Neon branch.
  That is a deliberate choice for a project this size, now documented rather than implicit.

- **Deployment blocker:** NO — resolved, and the rollback story is now written down.

---

### F-27 — No rate limiting anywhere, including on the AI endpoint

- **Status:** ⚠️ **PARTIALLY RESOLVED** — 2026-08-11. Per-request cost is now hard-capped
  (image size, type and count), and a per-caller budget guards the five named endpoints.
  **The limiter is per-instance, not shared**, so a durable one at the edge is still
  required. See *Resolution* at the end.
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** Resource exhaustion / cost
- **Location:** repository-wide; [app/api/store/ai/route.js:54-67](app/api/store/ai/route.js#L54-L67)
- **Evidence:** No rate-limiting middleware exists. `POST /api/store/ai` accepts
  `base64Image` with no size cap and forwards it to a paid vision model on every call.
  Acknowledged at [docs/ARCHITECTURE.md:143](docs/ARCHITECTURE.md#L143).
- **Impact:** Any approved seller can drive unbounded OpenAI spend. `POST /api/store/create`
  and `POST /api/store/product` upload to ImageKit with no size or count limit. Login-adjacent
  endpoints can be hammered freely.
- **Recommended fix:** Add per-user rate limiting at the edge (Vercel firewall or an Upstash
  token bucket) on `/api/store/ai`, `/api/store/product`, `/api/store/create`, `/api/orders`
  and `/api/coupon`. Cap `base64Image` size and validate `mimeType` against an allowlist.
- **Deployment blocker:** NO — becomes one if the deployment is publicly reachable with
  open seller registration.

#### Resolution — 2026-08-11 (partial)

**Root cause (confirmed).** Cost was unbounded in two independent dimensions and neither
was expressed anywhere. Nothing limited **how often** a caller could reach an endpoint
that spends money, and nothing limited **how much a single call could spend** — the AI
route forwarded a `base64Image` of any size and any claimed type straight to a paid vision
model. Either alone is enough: a size cap without a rate cap just means paying in
instalments, and a rate cap without a size cap means one permitted request can still push
50 MB through the model.

**Exact remediation — per-request cost, which is the part that is fully closed.**
[lib/uploadLimits.js](lib/uploadLimits.js) defines the ceilings, applied at three points:

- **`/api/store/ai`** — `mimeType` must be one of four displayable image types
  (allowlist, so an unexpected type is refused rather than forwarded), and the payload is
  rejected above 5 MB. Size is estimated from the base64 length **without decoding**:
  decoding to measure would allocate exactly the memory the cap exists to prevent.
- **`/api/store/product`** — at most 8 images, each type-checked and size-checked
  **before any upload begins**, so a bad batch costs one rejected request rather than
  several transfers to ImageKit.
- **`/api/store/create`** — the same checks for the store logo.

**Per-caller rate, applied to all five endpoints the audit named** —
[lib/rateLimit.js](lib/rateLimit.js), a fixed-window counter keyed by user:
AI 10/min (tightest, since every call is paid), store creation 5/min, orders 20/min,
coupon 20/min, product 30/min. A refusal returns **429** with `Retry-After` and is logged
as `rate_limited` through the F-14 logger, so abuse is countable rather than invisible.
The storefront is deliberately not limited: browsing is not the expensive path, and
throttling it would be a self-inflicted outage.

**Why not Upstash, and what that costs.** The recommendation offered a distributed token
bucket or the Vercel firewall. Both are external: one adds a dependency, a credential and
a network hop *on the path being protected*, and neither can be exercised from here — I
would be shipping an unverifiable integration and calling the finding closed. The local
limiter is honest about being a floor: **counters live in one instance's memory, so a
caller spread across N warm instances gets N times the budget, and a cold start forgets
everything.** That is written at the top of the module, not buried in a report. It bounds
the ordinary case — one client hammering one endpoint through a warm instance — and the
durable limiter remains outstanding.

**Also removed:** `console.log(raw)` in the AI route, which wrote the model's entire
response to the log stream on every call.

**Files changed.** `lib/rateLimit.js` (new), `lib/uploadLimits.js` (new),
`app/api/store/ai/route.js`, `app/api/store/product/route.js`,
`app/api/store/create/route.js`, `app/api/orders/route.js`, `app/api/coupon/route.js`,
`tests/unit_tests.test.js`, `tests/integration_tests.test.js`.

**Tests added.** 156 → 165 unit and 266 → 274 integration (441 total).

*Unit (9):* the limit allows then refuses; callers are counted separately; a fresh window
opens on expiry; `retryAfterSeconds` is never zero while blocked; remaining budget is
reported; **memory does not grow without bound** under 6,000 distinct keys; the type
allowlist accepts four types and refuses PDFs, SVG and rubbish; base64 size is estimated
without decoding; the ceilings are above any real upload.

*Integration (8):* the eleventh AI call is **429 with `Retry-After`** and never reaches
the paid model; sellers are budgeted separately; an oversized image is refused before
anything is spent; four bad mime types are refused; a product may not exceed 8 images; a
mixed batch containing a PDF is rejected **before any transfer starts**; two further named
endpoints are confirmed to have a budget and to enforce it at the documented number; and
the storefront is confirmed **not** limited across 50 consecutive requests.

**Verification performed.**

| Check | Result |
| --- | --- |
| Full suite | **441 passed** (was 424; +17) |
| `npm run build` | Compiled successfully with no database env at all |
| `npm run lint` | `✔ No ESLint warnings or errors` |
| `npm audit --audit-level=high` | exit 0 — F-01 still holding |
| **Mutation testing** | (a) the AI endpoint unlimited again — the original defect; (b) the size cap removed; (c) the type allowlist bypassed; (d) **one shared bucket instead of per-caller**; (e) the upload caps removed — each caught |

**A defect I introduced and the build caught.** My scripted import insertion added a
second `import { logger }` to `app/api/orders/route.js`, which already had one. **The
441-test suite passed anyway** — esbuild tolerates the duplicate — while `next build` and
ESLint both failed on it outright. It is fixed, and I swept every route for duplicate
imports to confirm it was the only one. Worth recording because it is a clean example of
why a green suite is not a green build, and why both stay in the loop.

**Residual risk.**

- **Open, and the substance of what remains — the limiter is not shared.** Per-instance
  counters mean the real ceiling is `limit × warm instances`, and cold starts reset it. A
  determined attacker with concurrency gets past it. A Vercel firewall rule or an Upstash
  bucket in front of these five routes is still required, and this does not substitute for
  it.
- **Open — a fixed window permits bursts at the boundary.** Up to `2 × limit` requests can
  land either side of a window edge. Acceptable for a spend guard; a sliding window or
  token bucket would smooth it.
- **Open — anonymous endpoints are unlimited.** Every limit is keyed by `userId`, so the
  public catalogue, the store page and the sign-in-adjacent routes have no budget at all.
  Those are the ones an edge limiter keyed by IP would cover, and it is the other half of
  why the durable limiter matters.
- **Low — the ceilings are judgements, not measurements.** 5 MB, 8 images, 10 AI calls a
  minute are comfortably above normal use and were not derived from observed traffic.
  They will need revisiting once there is any.
- **Low — `image.size` and `mimeType` are client-supplied.** The `File` metadata in a
  multipart body and the `mimeType` field are what the caller says they are; neither is
  verified against the bytes. A magic-number check would close that, and ImageKit rejects
  genuinely malformed images downstream.

- **Deployment blocker:** NO — per-request cost is capped and per-caller abuse is bounded
  at the instance. **It becomes one for a publicly reachable deployment with open seller
  registration**, exactly as the finding states, until a shared limiter is in front.

---

## 6. Critical User Flows Tested

| Flow | Method | Result |
| --- | --- | --- |
| Anonymous storefront browse | live HTTP `GET /`, `GET /api/products` | `/` **200** (prerendered). `/api/products` correctly returns a *generic* 500 without a DB — the only handler that sanitises its errors. |
| Authorization matrix — 10 mutating endpoints | live HTTP unauthenticated POST | **PASS.** All 401. Matches the project's own integration suite. |
| Authorization matrix — 9 read endpoints | live HTTP unauthenticated GET | **FAIL on one:** `/api/orders` executes a DB query with no session (F-05). |
| Seller onboarding (apply → pending → approve → sell) | code trace + existing suite | Logic correct. `authSeller` returns a store id or `false`, never `undefined` — the documented invariant holds. Gap: rejection leaves `isActive` true (F-23). |
| Checkout — happy path, COD | probe P6/P7 harness | Prices re-read from the DB; addresses scoped to `userId`; quantities must be positive integers; payment method validated against the enum. Core validation is **sound**. |
| Checkout — multi-seller basket | probe P7 | **FAIL.** Partial commit on failure (F-07). |
| Checkout — invalid input | existing suite + probes | Negative/fractional quantities, foreign `addressId`, expired coupon, unavailable product all correctly rejected. |
| Checkout — boundary: >100% coupon | probe P6 | **FAIL.** `total = -40`, HTTP 200 (F-11). |
| Payment confirmation — happy path | probe P2 | Correct: `updateMany isPaid`, cart cleared. |
| Payment confirmation — duplicate delivery | existing suite | **PASS.** Ledger short-circuits replays. |
| Payment confirmation — **transient failure then retry** | probe P2 | **FAIL.** Payment permanently lost (F-02). |
| Payment confirmation — forged webhook | live HTTP | **PASS.** Signature enforced, 400, no mutation. |
| Payment confirmation — out-of-order `canceled` | code trace | **PASS.** `deleteMany` is scoped to `isPaid: false`. |
| Seller order fulfilment | probe P3 | **FAIL.** Unpaid orders shown as fulfillable (F-03). |
| Cart persistence across sessions | code trace | **FAIL.** Cold-start race wipes the cart (F-09); failures invisible (F-10). |
| Rating gated on purchase | probe P9 | Partially correct — ownership and line-item match enforced; payment/delivery not (F-22). |
| New-user provisioning | code trace | **FAIL.** No fallback for the async user row (F-06). |
| Restart / recovery | live `next start` | App boots and serves with the DB unreachable; no readiness signal distinguishes "up" from "usable" (F-14). |
| External-service failure — Stripe down | probe P2 | Data loss (F-02). |
| External-service failure — DB down | live HTTP | Internal error text leaked to anonymous callers (F-05). |
| External-service failure — ImageKit / OpenAI down | code trace | Error propagates as a 400 toast. No retry, no timeout, no circuit breaker (F-28 territory — see §8). |

---

## 7. Security Audit

**What is done well.** Authorization lives next to data access rather than in middleware, and
the matrix holds under live probing. `authSeller` and `authAdmin` return `false` rather than
`undefined`, defusing Prisma's where-clause-drop footgun — a subtle bug the team clearly
understood and guarded. Order prices are recomputed server-side and never trusted from the
client. Addresses are scoped to `userId` at query time, closing the obvious IDOR. Ratings match
on order ownership *and* line item. `POST /api/address` allowlists its fields explicitly.
`safeInternalPath` correctly rejects scheme- and host-forms, so the `/loading?nextUrl=` redirect
is not an open redirect. Stripe signature verification is enforced and webhook replays are
deduplicated. No secrets are committed anywhere in the 9-commit history. All queries go through
Prisma's parameterised client — no SQL injection surface (the two `$queryRaw` uses are in
`scripts/check-env.mjs` and are static templates).

**What must be fixed.**

| Area | Status |
| --- | --- |
| Dependency vulnerabilities | **FAIL** — critical RCE in Next.js, 5 high (F-01) |
| Missing authorization | **FAIL** — `GET /api/orders` (F-05) |
| Information disclosure | **FAIL** — raw Prisma errors incl. DB host to anonymous callers, 18/21 handlers (F-05) |
| Privilege escalation | **AT RISK** — admin identity from an unverified email at array index 0 (F-12) |
| Input validation | **FAIL** — no schema validation on any endpoint (F-11, F-20, F-21) |
| Data exposure / PII | **FAIL** — buyer carts to sellers, seller PII publicly (F-16) |
| Rate limiting / abuse | **FAIL** — none, including on a paid AI endpoint (F-27) |
| Security headers | **FAIL** — none set (F-15) |
| Secrets management | **PASS** with a gap — `.gitignore` misses `.env.local` (F-24) |
| SQL injection | **PASS** |
| XSS | **PASS** — no `dangerouslySetInnerHTML`; React escaping throughout. CSP would add depth (F-15) |
| Open redirect | **PASS** — `safeInternalPath` |
| CSRF | **PASS** — Bearer-token auth via Clerk, not ambient cookies, on all mutating routes |
| Webhook authenticity | **PASS** — Stripe signature enforced; Inngest signing key configured via env |

---

## 8. Performance / Reliability Audit

**Performance.** No index exists on any foreign key (F-13), so every seller and buyer query is a
sequential scan. The public catalogue is fetched in full — with every review and complete store
rows — on every page load (F-19). `/api/admin/dashboard` loads all order rows into Node memory to
sum them rather than using `aggregate`. `/api/store/dashboard` issues three sequential queries that
could be one. The `forNewUser` coupon path scans `Order` by `userId` twice per checkout, unindexed.
Images are `unoptimized: true` (F: [next.config.mjs:4](next.config.mjs#L4)), so ImageKit
transformations carry all the weight and Next's optimiser is bypassed — defensible, but it means
every asset is served at whatever size ImageKit returns.

**Reliability.** There are **no timeouts** configured on any outbound call — Stripe, ImageKit,
OpenAI and Prisma all use library defaults, so a hung upstream ties up a serverless invocation to
its platform limit. There are **no retries** and **no circuit breakers**; a single ImageKit blip
fails product creation outright with no partial-success handling across the `Promise.all` upload
loop ([app/api/store/product/route.js:33-49](app/api/store/product/route.js#L33-L49) — a failure
after some uploads succeed orphans the uploaded files with no cleanup). There is **no graceful
degradation**: with the database unreachable the app still returns 200 on `/` and 400s on the API,
with nothing distinguishing "degraded" from "broken".

**Concurrency.** Multi-store checkout is non-transactional (F-07). Checkout has no idempotency key
and the submit button is not disabled (F-17). The webhook ledger is claimed outside the mutation's
transaction (F-02). Stock is a boolean with no quantity, so overselling is unbounded by design —
acceptable for the current model but worth stating explicitly.

**Resource leaks.** `lib/prisma.js` correctly memoises the client on `global` across hot reloads.
`neonConfig.poolQueryViaFetch` is set, and the WebSocket constructor is wired for the non-edge path.
No `$disconnect` on shutdown, which is correct for serverless. I found no leak in the request path.
The unbounded `User.cart` JSONB (F-20) is a storage-growth vector rather than a leak.

---

## 9. Deployment / Infrastructure Audit

**CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)). Solid for its size: checkout, Node
from `.nvmrc`, `npm ci`, lint, test, and a build smoke test using format-valid dummy Clerk keys with
a clear comment explaining why. Gaps: **no `npm audit`** (which is why F-01 went unnoticed), no
coverage gate, no branch protection evidence, no deployment job, and the build smoke test skips
`prisma migrate deploy` so migration validity is never exercised in CI.

**Build** ([package.json:8](package.json#L8)). `prisma generate && prisma migrate deploy && next build`
couples schema migration to the build (F-26). Migrations run while the previous version still serves
traffic, concurrent builds race, and rollback does not revert the schema.

**Configuration.** `scripts/check-env.mjs` is genuinely good — it validates 16 variables by format,
distinguishes required from deferred, and pings the database. Two problems: it reads `.env` directly
rather than the process environment, so it **cannot validate a Vercel deployment**, and it classifies
`STRIPE_WEBHOOK_SECRET` as optional (F-08). `.env.example` is complete and well commented.

**Containerisation.** None. Vercel-native. Reasonable for the stated model, but it means there is no
way to reproduce the production runtime locally and no image to pin or scan.

**Database.** Single baseline migration, applied cleanly in structure (reviewed by hand — enums, tables,
FKs and the three unique indexes all match `schema.prisma`). No down migrations, no seed-safety guard
against running `npm run seed` against production data (the README instructs exactly that at step 6 —
the script is upsert-based and therefore idempotent, but it also **uploads to ImageKit and overwrites
files by fixed name**, so re-running it in production mutates the media library). No documented backup
or point-in-time-recovery policy; Neon provides branching, but nothing in the repo says it is enabled.

**Secrets.** Managed through Vercel env vars per the README. No rotation policy documented. `ADMIN_EMAIL`
as the sole admin control means changing administrators requires a redeploy — acknowledged in the
architecture doc.

---

## 10. Missing Tests / Coverage Gaps

The existing 176 tests are better than typical: they mock only at external boundaries, they were
validated by mutation testing, and they encode real invariants (the `authSeller` `undefined` case,
cart total consistency under randomised operation sequences, webhook idempotency). The gaps are in
what was never modelled at all, and every confirmed finding above is a gap.

**High-risk paths with no test:**

1. **Webhook failure-then-retry** (F-02) — the suite tests duplicate delivery but never a *failed*
   delivery followed by a retry. This is the single highest-value missing test in the repository.
2. **Payment-state filtering** (F-03, F-04) — no test asserts that seller views and revenue
   aggregates exclude unpaid orders. No assertion compares buyer and seller queries for consistency.
3. **Unauthenticated GET matrix** — the suite covers anonymous POSTs thoroughly but not anonymous
   GETs, which is why F-05 survived.
4. **Transactionality** (F-07) — no test injects a mid-loop failure.
5. **Missing-`User`-row behaviour** (F-06) — no test covers `P2003`/`P2025` on cart, address or order.
6. **The cart cold-start race** (F-09) — the cart tests cover reducer invariants, not the
   fetch/upload effect interaction. Requires a component or fake-timer test.
7. **Boundary values on money** — no test for `discount > 100`, `discount = 0`, `total = 0`,
   or per-store rounding drift.
8. **Response-shape assertions** — no test asserts that `/api/products` omits seller PII or that
   `/api/store/orders` omits `User.cart` (F-16). Snapshot tests on the response DTOs would lock this.
9. **No component or browser E2E tests at all** — acknowledged in the architecture doc. The entire
   UI, including checkout, is covered "by build and review only". The F-09 and F-17 defects both
   live in exactly that untested layer.
10. **No load or soak testing** — F-13 and F-19 are invisible at seed scale.
11. **No coverage measurement** — `vitest --coverage` is not configured, so the untested surface
    is unquantified.

---

## 11. Unverified Areas and Required External Checks

Stated precisely, with the reason each could not be closed.

| # | Area | Why unverified | Required check |
| --- | --- | --- | --- |
| 1 | **Migration application** | No live `DATABASE_URL`; Docker daemon not running (`docker info` failed) and no local Postgres binary. | `prisma migrate deploy` against a scratch Neon branch, then `prisma migrate diff` to confirm the schema matches. |
| 2 | **Seed script** | Requires a live database **and** live ImageKit credentials with network access. | `npm run seed` twice against a scratch branch to confirm idempotency and that ImageKit `overwriteFile` behaves as documented. |
| 3 | **`npm run check` database half** | Exits at "No .env file found". | Run with real credentials; confirm it fails correctly on a suspended Neon project. |
| 4 | ~~**F-12 admin escalation**~~ | ~~Requires a live Clerk tenant.~~ **CLOSED 2026-08-11 by the F-12 fix.** Questions (a) unverified address at index 0, (b) claiming an unowned address, and (c) array ordering are all **moot**: authorization now resolves the primary address by id and requires `verification.status === 'verified'`, so none of those behaviours can grant access. | Remaining, and much weaker: confirm at first deploy that the real admin account *is* admitted. A wrong model of the Clerk shape now locks an admin out rather than letting an attacker in. |
| 5 | **Real Stripe webhook delivery** | No Stripe test account or tunnel. | `stripe listen --forward-to localhost:3000/api/stripe` and drive a full checkout; then force a mid-handler failure to reproduce F-02 against real Stripe retries. |
| 6 | **Clerk → Inngest user sync** | External configuration not represented in this repository. | Confirm the integration exists in the Clerk dashboard, then measure the lag between sign-up and the `User` row appearing — this quantifies F-06's blast radius. |
| 7 | **Inngest function registration** | Requires a deployed URL for the sync step. | Sync at `/api/inngest`, confirm all four functions register, and verify `deleteCouponOnExpiry`'s `sleepUntil` fires. |
| 8 | **Clerk `plus` plan / `has({plan:'plus'})`** | Requires a configured billing plan. | Verify free shipping and member-only coupons resolve correctly for both plan states, and that `has` is present on every `getAuth` result. |
| 9 | **Index impact (F-13)** | No database to profile. **Still open after the F-13 fix**, which is structural only: the indexes are declared and match Prisma's own DDL, but none has ever been created and no query has been timed. | `EXPLAIN ANALYZE` the seller dashboard and buyer order queries at ~10k orders, confirm the planner uses `Order_storeId_idx` / `Order_userId_idx` rather than a sequential scan, and decide whether `(storeId, createdAt)` should replace `(storeId)`. |
| 10 | **Production headers and TLS** | Not deployed. | Re-run the F-15 header check against the live Vercel URL; Vercel supplies HSTS but not the rest. |
| 11 | **Node 22 parity** | Audit and all remediation ran on Node v25.2.1. **Partly closed by F-25**: the range is now declared (`engines: 22.x`) and enforced (`engine-strict`), so this machine can no longer install — the drift is surfaced rather than tolerated. The suite has still never been executed on 22. | Re-run the full suite and build on Node 22 (CI does this on every push, so the first green CI run closes it), and confirm Vercel's build log shows the pinned runtime. |
| 12 | **Load behaviour** | No environment. | Load test `/api/products` and checkout at expected peak, post-F-13/F-19 fixes. |

---

## 12. Pre-Deployment Checklist

**Blockers — must be complete before any production traffic**

- [x] ~~**F-01** Bump `next` to 15.5.23; run `npm audit fix`; re-run build and suite; add `npm audit --audit-level=high` to CI and enable Dependabot.~~ **DONE 2026-08-11** — `npm audit` reports 0 vulnerabilities; CI gate and Dependabot added. Also required transitive `overrides` for `postcss`/`sharp`/`uuid`, which `next@15.5.23` pins to vulnerable versions.
- [x] ~~**F-02** Move the `ProcessedWebhookEvent` claim inside the same `$transaction` as the order mutation.~~ **DONE 2026-08-11** — implemented as a two-phase ledger (`completedAt`), since a claim alone must not suppress a retry; mutations and the completion mark now commit together.
- [ ] **F-02 (remainder)** Add the Stripe reconciliation job — a scheduled sweep repairing any order still `isPaid: false` behind a succeeded payment intent. **Still open**; the handler is self-healing across Stripe's retry window, but nothing detects a payment lost beyond it.
- [x] ~~**F-03** Add the paid-or-COD filter to `GET /api/store/orders`.~~ **DONE 2026-08-11** — extracted to a single shared `PLACED_ORDER` predicate used by both the buyer and seller views, and applied to the seller status update as well, so an unpaid order is not fulfillable by direct API call either.
- [x] ~~**F-04** Add the same filter to both dashboard revenue aggregates.~~ **DONE 2026-08-11** — applied the shared `PLACED_ORDER` predicate to seller earnings/order count and to the admin count, revenue sum and orders-per-day chart. Expect the displayed figures to drop by the checkout abandonment rate.
- [x] ~~**F-05** Add the `!userId` guard to `GET /api/orders`. Replace `error.code || error.message` with sanitised responses across all 18 affected handlers.~~ **DONE 2026-08-11** — guard added; all 31 catch blocks across 20 route files now delegate to a single `lib/apiError.js`; unhandled failures return 500 (Stripe signature failures stay 400). Both invariants are now enforced by generated tests rather than hand-maintained lists.
- [x] ~~**F-06** Add an idempotent `ensureUser` upsert on every authenticated write path.~~ **DONE 2026-08-11** — `lib/ensureUser.js` provisions from the Clerk session on all five write paths; enforced by a structural test. Checkout no longer depends on the Inngest sync.
- [ ] **F-06 (remainder)** Verify the Clerk→Inngest integration end to end. **Still open** — no longer blocks provisioning, but `clerk/user.updated` and `clerk/user.deleted` still depend on it, so without it profile data goes stale and deleted accounts keep their rows.
- [x] ~~**F-07** Wrap multi-store order creation in `$transaction`.~~ **DONE 2026-08-11** — per-store orders and the COD cart clear commit as one unit; the Stripe leg compensates by deleting the orders if the checkout session cannot be created.
- [x] ~~**F-08** Set `STRIPE_WEBHOOK_SECRET` **before** enabling Stripe checkout; make the route refuse `STRIPE` payments when it is unset; promote it to required in `check-env.mjs`.~~ **DONE 2026-08-11** — `POST /api/orders` returns 503 for card checkout when the secret is unset (no order created, Stripe never called); `npm run check -- --production` fails the deploy; README corrected. **Still run `npm run check -- --production` before release** — the gate is opt-in.

**Strongly recommended before launch**

- [x] ~~**F-09** Gate `uploadCart` on load state.~~ **DONE 2026-08-11** — the cart slice now distinguishes "empty" from "not loaded"; nothing is written back until the cart has been read, and a failed read keeps uploads blocked rather than guessing.
- [x] ~~**F-10** Fix the unreachable error handler.~~ **DONE 2026-08-11** — the thunk awaits the debounce, so a failed write rejects it and lands in a new `syncError` field instead of becoming an unhandled rejection.
- [ ] **F-10 (follow-up)** Surface `syncError` in the UI. The failure is now observable in state but no component reads it, so a shopper still gets no signal that their cart stopped saving.
- [x] ~~**F-12** Use Clerk's primary, verified email in `authAdmin`. Close open item §11.4 first.~~ **DONE 2026-08-11** — resolves the primary address by id and requires `verification.status === 'verified'`; every other shape fails closed. §11.4 is closed as moot rather than investigated. Moving admin identity off an env var to metadata or a roles table remains a longer-term item.
- [x] ~~**F-13** Add indexes on all foreign keys; generate and apply the migration.~~ **DONE 2026-08-11** — seven indexes added by migration; three foreign keys were already covered as the leading column of an existing index and were deliberately left alone. **The migration has not been applied anywhere and the speed-up is unmeasured** — see §11.9.
- [x] ~~**F-14** Add `/api/health`; wire structured logging.~~ **DONE 2026-08-11** — `GET /api/health` returns 200/503 on database reachability; all failures emit structured JSON with a correlation id returned to the caller; the money path emits countable events.
- [ ] **F-14 (remainder)** Wire an error tracker and **define the §13 alerts**. **Still open, and the most consequential item left** — the events exist to alert on, nothing is watching them, so F-02's reconciliation gap and F-08's stale-secret case remain silent.
- [x] ~~**F-15** Set security headers; `poweredByHeader: false`.~~ **DONE 2026-08-11** — all five delivered live on pages and API routes; `X-Powered-By` removed; `frame-ancestors 'none'` enforced.
- [ ] **F-15 (remainder)** Promote the CSP resource policy from report-only to enforcing. **Still open** — load the deployed app in a browser against the real Clerk tenant, confirm the console shows no CSP violations across sign-in, checkout and image loading, then rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Until then it provides no protection.
- [x] ~~**F-16** Replace `include: true` with explicit `select`; stop returning `User.cart` to sellers.~~ **DONE 2026-08-11** — six call sites narrowed to the fields their screens render; buyers' carts and Clerk ids no longer leave the server, and the public catalogue no longer carries seller contact details.
- [x] ~~**F-27** Cap upload and base64 sizes.~~ **DONE 2026-08-11** — image size, type and count are hard-capped before any spend; a per-caller budget guards all five named endpoints and returns 429 with `Retry-After`.
- [ ] **F-27 (remainder)** Put a **shared** rate limiter in front (Vercel firewall or Upstash). **Still open, and it is the substance of this finding** — the in-repo limiter is per-instance, so the real ceiling is `limit × warm instances`, and anonymous endpoints have no budget at all. Required before the deployment is publicly reachable with open seller registration.
- [x] ~~**F-11** Allowlist coupon fields, bound `discount`, clamp the order total.~~ **DONE 2026-08-11** — `lib/couponInput.js` validates creation; the order path clamps at `>= 0` so pre-existing bad rows cannot price negative. No validation library was added for a single endpoint — see the finding for the reasoning.
- [x] ~~**F-20** Validate the cart body.~~ **DONE 2026-08-11** — `lib/cartInput.js` enforces a flat id→quantity map with caps on items, quantity and id length; unknown ids are dropped rather than stored. **The zod question is settled: no** — see the finding for the reasoning; validation stays as one pure `lib/*Input.js` module per shape.
- [x] ~~**F-21** Validate the order status against the `OrderStatus` enum and enforce forward-only transitions.~~ **DONE 2026-08-11** — unknown statuses are refused; the direction rule is applied inside the update rather than by a preceding read; each transition is logged as `order_status_changed`.
- [x] ~~**F-17** Disable the submit button in flight; add an idempotency key.~~ **DONE 2026-08-11** — button has an in-flight state; the endpoint deduplicates on an `Idempotency-Key` claimed inside the order transaction, released by the Stripe compensation, and resolving concurrent duplicates to the winner.
- [x] ~~**F-18** Make the price shown equal the price charged.~~ **DONE 2026-08-11** — all money arithmetic is exact integer-cent work behind one `priceBasket()` shared by the cart summary and the checkout; Stripe is charged the same integers that are persisted.
- [ ] **F-18 (remainder)** Migrate money columns to integer minor units or `Decimal`. **Still open** — measurement showed `Float` storage round-trips exactly and is not currently producing error, so this is a latent hazard rather than an active defect; any future arithmetic bypassing `lib/money.js` reintroduces the class.
- [x] ~~**F-19** Replace the admin revenue `findMany` with an aggregate; add `GET /api/products/[id]`.~~ **DONE 2026-08-11** — revenue and the order count come from one `aggregate`; the chart is bounded to the 30 days it shows; the product page fetches by id and reports a missing product instead of rendering blank.
- [ ] **F-19 (remainder)** Paginate `/api/products` and aggregate ratings server-side. **Still open** — the full list is load-bearing for shop search and for cart/`OrderSummary` product resolution, so it needs server-side search plus an `ids` lookup, coordinated across four components with no component tests to catch a mistake.
- [x] ~~**F-22** Gate reviews on delivery; limit coupon redemption.~~ **DONE 2026-08-11** — a review requires a delivered, placed order; a coupon is one use per shopper with an optional platform-wide cap, derived from orders that stand rather than a separate ledger.
- [x] ~~**F-23** Set `isActive: false` on rejection; share one store-eligibility predicate.~~ **DONE 2026-08-11** — `SELLABLE_STORE` used by all four public reads; rejection now switches the store off. **One-off data fix outstanding:** `UPDATE "Store" SET "isActive" = false WHERE status = 'rejected'` for stores rejected before this change.
- [x] ~~**F-24** `.gitignore` → `.env*` with `!.env.example`.~~ **DONE 2026-08-11** — all six env variants ignored, template still tracked, verified by asking git directly.
- [x] ~~**F-26** Separate migrations from the build; write down the rollback procedure; snapshot the Neon branch before release.~~ **DONE 2026-08-11** — build no longer touches the database; migration is a gated `workflow_dispatch`; additive-only enforced by test; *Releases* section in the README covers snapshot and rollback. **Note the trade:** nothing now forces migrations to run, so a deploy can ship ahead of its schema — run `npm run migrate:status` before deploying.
- [ ] Add the tests listed in §10, items 1–5, before shipping the fixes they cover.

**Operational readiness**

- [ ] Confirm Neon backups / PITR are enabled and a restore has been rehearsed.
- [ ] Verify all four Inngest functions register after deploy.
- [ ] Confirm `ADMIN_EMAIL` matches a real, verified Clerk account and that `/admin` is reachable by it and by nobody else.
- [ ] Run `npm run seed` against production exactly once, knowingly (it writes to ImageKit).
- [x] ~~Pin the Vercel Node version to 22.~~ **DONE 2026-08-11 (F-25)** — `engines: {"node": "22.x"}` is the mechanism Vercel reads; confirm it took effect in the first build log.
- [ ] Document an on-call runbook for: payment taken but order unpaid; webhook 4xx spike; database unreachable.

---

## 13. Post-Deployment Monitoring Checklist

**Alert on (page someone):**

- `POST /api/stripe` non-2xx rate > 0 over 5 minutes — the F-02 signature.
- Any webhook response with `duplicate: true` that is **not** preceded by a successful
  processing of that event id — direct detection of a burned ledger entry.
- Orders with `paymentMethod = 'STRIPE'` and `isPaid = false` older than 1 hour, count > 0.
- Stripe dashboard succeeded-payment count vs. application paid-order count, hourly — the
  authoritative reconciliation for F-02 and F-08.
- Database connection errors, any occurrence.
- 5xx rate on `/api/orders` > 1%.

**Track (dashboard, review daily):**

- Checkout funnel: `POST /api/orders` → session created → `payment_intent.succeeded`. A widening
  gap is the F-02/F-08 symptom.
- p95 latency on `/api/products`, `/api/orders`, `/api/store/dashboard` — the F-13/F-19 canaries.
- Neon connection count and cold-start frequency (drives F-09).
- Inngest function success rate, especially `sync-user-create` — failures here break checkout (F-06).
- `P2003` / `P2025` Prisma error counts — the direct F-06 signal.
- ImageKit and OpenAI error rates and spend (F-27).
- `User.cart` row size distribution (F-20 abuse detection).
- Orders with `total <= 0` — should be zero (F-11).

**Verify in the first hour after deploy:**

- `/api/health` (once F-14 is done) returns healthy with database connectivity.
- One end-to-end COD order and one end-to-end Stripe order, confirmed paid via the webhook.
- Admin console reachable by the `ADMIN_EMAIL` account and refused for a second test account.
- A new sign-up produces a `User` row within the expected lag, then completes a checkout.
- Storefront renders with the seeded catalogue.

---

## 14. Final Risk Assessment

| Risk | Likelihood | Impact | Composite |
| --- | --- | --- | --- |
| Payment captured, order lost (F-02, F-08) | **High** — any Stripe/Neon blip, plus a guaranteed window at first deploy | **Severe** — silent, unrecoverable revenue loss and a customer-support incident with no audit trail | **CRITICAL** |
| RCE / middleware bypass via Next.js (F-01) | Medium — publicly disclosed, exploit paths documented | **Severe** — full compromise of the runtime holding all customer data | **CRITICAL** |
| Sellers ship unpaid goods (F-03) | **High** — every abandoned checkout produces one | **Severe** — direct inventory loss, trivially abusable at scale | **CRITICAL** |
| New users cannot check out (F-06) | Medium — certain if Inngest is misconfigured, intermittent otherwise | **Severe** — primary revenue flow broken for exactly the users you are acquiring | **HIGH** |
| Wrong financial reporting (F-04) | **Certain** — the code always does this | High — misinformed payouts and business decisions | **HIGH** |
| Partial orders from a failed multi-store checkout (F-07) | Medium | High — inconsistent state, duplicate fulfilment on retry | **HIGH** |
| Admin takeover via unverified email (F-12) | Unknown — see §11.4 | **Severe** if realisable | **HIGH (unresolved)** |
| Cart data loss on cold start (F-09) | Medium-High — Neon auto-suspends, and the README says so | Medium — lost baskets, lost conversions | **MEDIUM** |
| Infrastructure disclosure via raw errors (F-05) | **Certain** | Medium — reconnaissance aid | **MEDIUM** |
| Performance collapse under load (F-13, F-19) | High at any real scale | Medium — degradation before outage | **MEDIUM** |
| Cost abuse via unlimited AI/upload calls (F-27) | Medium | Medium — unbounded third-party spend | **MEDIUM** |
| Blind production incidents (F-14) | **Certain** | High as a **multiplier** — it is what turns F-02 from recoverable into silent | **MEDIUM** |

**Overall risk: HIGH. Verdict: NOT READY.**

The honest summary is that this codebase demonstrates real engineering judgement — the
authorization model is sound and deliberately reasoned about, prices are recomputed
server-side, webhook replays are deduplicated, and the test suite was built to find defects
rather than to inflate a coverage number. Those are not common in a project this size.

But the money path has three independent ways to lose revenue (F-02, F-03, F-08), each of
which fails *silently* because there is no observability to catch it (F-14) and no
reconciliation to repair it. That combination — undetected financial loss — is what makes
this a NOT READY rather than a READY WITH CONDITIONS. Layered on top is a runtime carrying
an unpatched critical RCE (F-01).

None of the blockers are architectural. Every one is a localised change: a transaction
boundary, a `where` predicate, an auth guard, an upsert, a dependency bump. Re-audit after
the eight blockers and the §10 tests that cover them are complete; my expectation is that
this reaches READY WITH CONDITIONS at that point, with F-12's resolution and a load test
being the remaining gates.

---

*Audit performed against commit `6e2ed61`. No application or source code was modified;
`git status` was clean before and after. All probe scripts were written to the session
scratchpad, outside the repository.*

---

# 15. Residual Risk Register

Every residual risk recorded against findings F-01…F-27, collected in one place
and triaged. **110 items**, of which 3 were already closed by later findings.

Each is marked:

- **FIXED** — corrected in the remediation pass of 2026-08-11 (§16).
- **ENV** — deferred by instruction: needs an environment variable, a credential,
  an external service or a live deployment. Cannot be closed from the repository.
- **ACCEPTED** — a deliberate trade, with the reasoning recorded against its
  finding. Not work left undone.

| # | Finding | Residual risk | Triage |
| --- | --- | --- | --- |
| 1 | F-01 | `next lint` deprecated in Next 15.5 | **FIXED** |
| 2 | F-01 | Overrides need review at the next major upgrade | ACCEPTED |
| 3 | F-01 | Overrides are a tree-wide instruction | ACCEPTED |
| 4 | F-02 | **No Stripe reconciliation job** — the dominant risk for the money path | **FIXED** |
| 5 | F-02 | "No checkout session found" treated as terminal | **FIXED** |
| 6 | F-02 | Interactive transactions need a TCP connection (edge runtime caveat) | **FIXED** (guard test) |
| 7 | F-02 | Historical lost payments not auto-repaired | **FIXED** (reconciliation sweeps them) |
| 8 | F-03 | Unpaid orders vanish from the seller dashboard | ACCEPTED (intended) |
| 9 | F-03 | Seller list still returns the full buyer row | Closed by F-16 |
| 10 | F-03 | No reconciliation of stale unpaid rows | **FIXED** (retention job) |
| 11 | F-04 | Displayed figures drop at deploy | ACCEPTED (a correction) |
| 12 | F-05 | Clients now show a generic message on internal failure | ACCEPTED (with `errorId`) |
| 13 | F-05 | No alerting on the new 5xx signal | ENV |
| 14 | F-05 | `/api/store/stock-toggle` answers 400 before authenticating | **FIXED** |
| 15 | F-05 | The `PUBLIC` allow-list is a judgement call | ACCEPTED (reviewed) |
| 16 | F-06 | Clerk→Inngest integration unverified | ENV |
| 17 | F-06 | Extra latency on a user's first write | ACCEPTED |
| 18 | F-06 | A stale mirrored row is never refreshed | **FIXED** |
| 19 | F-06 | FK behaviour inferred, not executed | ENV (needs a database) |
| 20 | F-07 | Narrow compensation window after commit | ACCEPTED (bounded) |
| 21 | F-07 | **Orphans still count toward `forNewUser`** | **FIXED** |
| 22 | F-07 | Transaction spans N inserts | ACCEPTED |
| 23 | F-07 | Rollback itself unverified | ENV (needs a database) |
| 24 | F-08 | A stale or wrong webhook secret is undetectable at order time | ENV |
| 25 | F-08 | Stripe option still offered when card payment is unavailable | ENV (derives from a variable) |
| 26 | F-08 | `--production` preflight is opt-in | ENV |
| 27 | F-09 | Cart cannot sync after a failed fetch, for that page load | ACCEPTED |
| 28 | F-09 | One redundant write per page load | **FIXED** |
| 29 | F-09 | Unverified in a browser | **FIXED** (component tests) |
| 30 | F-10 | **Nothing renders `syncError`** | **FIXED** |
| 31 | F-10 | No retry or backoff on a failed cart write | **FIXED** |
| 32 | F-10 | Debounce state is module-level | ACCEPTED (documented) |
| 33 | F-11 | Twenty other endpoints parse nothing | **FIXED** (guard + remaining bodies) |
| 34 | F-11 | **A 100% coupon can produce a £0 Stripe session** | **FIXED** |
| 35 | F-11 | Existing out-of-range coupon rows not repaired | **FIXED** (data migration) |
| 36 | F-12 | Admin identity is an environment variable | ENV |
| 37 | F-12 | Depends on Clerk's `verification.status` semantics | ACCEPTED (fails closed) |
| 38 | F-12 | Unverified against a live Clerk tenant | ENV |
| 39 | F-13 | Index impact unmeasured | ENV (needs a database) |
| 40 | F-13 | No composite or covering indexes | **FIXED** |
| 41 | F-13 | `CREATE INDEX` locks writes | ACCEPTED (documented) |
| 42 | F-13 | Seven indexes cost writes | ACCEPTED |
| 43 | F-14 | No error tracker | ENV |
| 44 | F-14 | **No alerting** | ENV |
| 45 | F-14 | No metrics or tracing | ENV |
| 46 | F-14 | Six unstructured `console.*` calls remain | **FIXED** |
| 47 | F-14 | No per-request correlation id | **FIXED** |
| 48 | F-14 | Healthy path of `/api/health` unverified | ENV (needs a database) |
| 49 | F-15 | **CSP resource policy is report-only** | ENV (needs a browser + live Clerk) |
| 50 | F-15 | `'unsafe-inline'` limits what the policy is worth | ACCEPTED |
| 51 | F-15 | `includeSubDomains` is a commitment | ACCEPTED |
| 52 | F-15 | Headers set by the app, not the edge | ACCEPTED |
| 53 | F-16 | Relation guard is textual | **FIXED** (strengthened) |
| 54 | F-16 | Field lists are point-in-time | ACCEPTED (fails safe) |
| 55 | F-16 | Buyer PII reaches sellers by design | ACCEPTED |
| 56 | F-17 | Client guard untested | **FIXED** (component tests) |
| 57 | F-17 | **`CheckoutRequest` rows accumulate** | **FIXED** (retention job) |
| 58 | F-17 | A key is honoured regardless of basket contents | **FIXED** |
| 59 | F-17 | Keys never expire | **FIXED** (retention job) |
| 60 | F-17 | Concurrent race unverified | ENV (needs a database) |
| 61 | F-18 | Money columns are still `Float` | ACCEPTED (measured as non-contributing) |
| 62 | F-18 | Nothing forces new code through the money module | **FIXED** (guard test) |
| 63 | F-18 | Client display unverified in a browser | **FIXED** (component tests) |
| 64 | F-19 | **`/api/products` is unpaginated** | **FIXED** |
| 65 | F-19 | Every review travels with every product | **FIXED** |
| 66 | F-19 | Chart narrowed to 30 days | ACCEPTED (labelled) |
| 67 | F-19 | One extra request on the product page | ACCEPTED |
| 68 | F-19 | No measurement | ENV (needs a database) |
| 69 | F-20 | Request body unbounded at parse time | **FIXED** |
| 70 | F-20 | One extra query per cart write | ACCEPTED |
| 71 | F-20 | Purchasability not checked in the cart | ACCEPTED (checkout re-validates) |
| 72 | F-21 | **No durable audit trail of status changes** | **FIXED** |
| 73 | F-21 | `DELIVERED` is terminal; no cancellation path | ACCEPTED (product gap) |
| 74 | F-21 | UI still offers unreachable statuses | **FIXED** |
| 75 | F-22 | Redemption check is read-then-write | ACCEPTED (reasoned) |
| 76 | F-22 | Platform cap has the same race | ACCEPTED |
| 77 | F-22 | Historical coupon use not counted | ACCEPTED |
| 78 | F-22 | Reviews do not prove receipt | ACCEPTED |
| 79 | F-23 | **Existing rejected-but-active stores not repaired** | **FIXED** (data migration) |
| 80 | F-23 | `authSeller` ignores `isActive` | **FIXED** |
| 81 | F-23 | Eligibility guard is textual | **FIXED** (strengthened) |
| 82 | F-24 | Prevents but does not detect committed secrets | **FIXED** (CI scan) |
| 83 | F-24 | Only env files are covered | **FIXED** (scan covers all) |
| 84 | F-24 | Tests require git | ACCEPTED (fails loudly) |
| 85 | F-25 | This machine no longer satisfies the range | ACCEPTED (the finding, surfaced) |
| 86 | F-25 | `22.x` is stricter than needed | ACCEPTED |
| 87 | F-25 | Vercel runtime inferred, not asserted | ENV |
| 88 | F-25 | npm version unconstrained | **FIXED** |
| 89 | F-26 | **A forgotten migration is now possible** | **FIXED** (CI drift check) |
| 90 | F-26 | Gated workflow unexercised | ENV (needs secrets) |
| 91 | F-26 | Additive-only check is textual | ACCEPTED (raises the floor) |
| 92 | F-26 | No down migrations | ACCEPTED (documented) |
| 93 | F-27 | **Rate limiter is per-instance, not shared** | ENV (needs Upstash / edge) |
| 94 | F-27 | Fixed window permits boundary bursts | **FIXED** (sliding window) |
| 95 | F-27 | **Anonymous endpoints are unlimited** | **FIXED** |
| 96 | F-27 | Ceilings are judgements | ACCEPTED |
| 97 | F-27 | `image.size` and `mimeType` are client-supplied | **FIXED** (magic-number check) |

**Totals:** 38 FIXED · 18 ENV (deferred by instruction) · 41 ACCEPTED · 3 already
closed by later findings.

---

# 16. Residual Risk Remediation — 2026-08-11

Every **FIXED** item from §15, and what was done. Environment-dependent items are
untouched by instruction and listed in §17.

## Correctness defects still standing after the finding-by-finding pass

| # | Was | Now |
| --- | --- | --- |
| 21 | `forNewUser` counted **every** order, so an abandoned checkout made a genuinely new shopper ineligible | Counts placed orders only, via `PLACED_ORDER` |
| 34 | A 100% coupon plus member shipping produced a **zero-amount Stripe session**, which Stripe rejects — checkout failed outright | A basket that costs nothing is settled directly: orders marked paid, cart cleared, no payment page |
| 58 | An idempotency key was honoured **whoever presented it**, so one shopper could be handed another's checkout outcome | Scoped to the owning user; a mismatch is a 409 |
| 14 | `/api/store/stock-toggle` validated its body before authenticating, describing its own shape to anonymous callers | Authenticates first. The `NON_401` exception in the F-05 matrix is gone — every guarded endpoint now answers 401 |
| 80 | `authSeller` checked `status` but not `isActive`, so a **deactivated** store could still add products, which then sat invisible | Requires approved *and* active |
| 18 | A `User` row provisioned by `ensureUser` was never refreshed, so a placeholder stayed stale forever if the Clerk sync was absent | A row that is obviously a placeholder is repaired from Clerk; a complete row is left alone, and `cart` is never touched |

## The money path's missing safety net

| # | What was added |
| --- | --- |
| 4, 7 | **`reconcileStripePayments`** — hourly Inngest job. Lists succeeded payment intents from the last 24h, resolves their sessions, and marks any order still `isPaid: false`. This is the backstop for a webhook that failed every retry, and it repairs historical damage rather than only preventing new. A repair logs at **error** level: it should never be routine |
| 5 | A missing checkout session is now **retryable rather than terminal** — completing the claim would drop a payment whose session was merely not visible yet |
| 10, 57, 59 | **`pruneCheckoutArtifacts`** — daily. Clears idempotency keys past 30 days and abandoned card orders past 30 days, far outside the reconciliation window so nothing awaiting repair is destroyed. COD orders are never touched |

## Scale and cost

| # | Was | Now |
| --- | --- | --- |
| 64 | The catalogue returned **every** purchasable product on every page load | Cursor-paginated, 24 by default and 100 at most, with `nextCursor` |
| 65 | **Every review** travelled with every product | `ratingCount` and `ratingAverage`; the reviews themselves only on the product page, which is the only screen that renders them |
| — | Search filtered the downloaded page, so a match further in was unreachable | Searched in the database, across name and category |
| — | Paginating would have silently emptied baskets, since the cart resolved items out of the loaded list | A `byId` index plus `?ids=` resolution: the cart fetches anything it does not hold |
| 40 | Single-column indexes on `Order.userId` / `Order.storeId` served the filter but not the sort | Replaced by `(userId, createdAt)` and `(storeId, createdAt)`; the redundant ones dropped |
| 69 | The cart body was capped only *after* being parsed | `Content-Length` refused above 128 KB before parsing — advisory, since a client can omit it |

## Abuse and integrity

| # | Was | Now |
| --- | --- | --- |
| 94 | A fixed window let 2× the limit land either side of a boundary | Sliding window. Measured: 20 attempted across a boundary now yields **11 allowed, not 20** |
| 95 | Every limit was keyed by `userId`, so unauthenticated endpoints had **no budget at all** | The three public reads are budgeted by caller address, 120/min, generous enough that browsing is unaffected |
| 97 | `mimeType` and `File.size` are both caller-supplied strings | Magic-number validation: the bytes must match the claimed type. A PDF relabelled `image/png` is refused before any upload or model call |
| 33 | Twenty endpoints parsed nothing | The remaining bodies are validated, and a structural test now refuses hand-rolled currency arithmetic in any route |

## Observability

| # | Was | Now |
| --- | --- | --- |
| 46 | Six unstructured `console.*` calls remained | None. `grep -rn "console\." app/api lib middlewares inngest` returns only the logger itself |
| 47 | The correlation id was per *failure*, so two lines from one request could not be tied together | `apiError` takes the request and logs `requestId` from `x-vercel-id`, threaded through all 32 catch blocks |
| 30 | Nothing rendered `syncError`, so a shopper still had no idea their cart had stopped saving | A non-blocking banner in the public layout |
| 31 | A failed cart write was reported and dropped | One retry on a transient failure; a 4xx is not retried, because retrying a refusal just fails again |
| 72 | Status transitions existed only as log lines | **`OrderStatusChange`** table, written in the same transaction as the update, recording what the order moved *from* |
| 74 | The seller dropdown offered statuses the server refuses | Unreachable options are disabled |

## Tooling and guards

| # | Was | Now |
| --- | --- | --- |
| 1 | `next lint` is deprecated and removed in Next 16 | `eslint .`, verified to catch a real error |
| 88 | Only Node was pinned | `engines.npm: ">=10"` |
| 82, 83 | Nothing detected a committed secret | Gitleaks in CI over full history — the detective half of F-24's prevention |
| 89 | Nothing stopped a deploy shipping ahead of its schema | A test asserting **every model and every column** in `schema.prisma` has a migration. Verified against both a forgotten field and a forgotten model |
| 62 | Nothing forced new code through the money module | A test refusing `* 100`, `/ 100` or `.toFixed(2)` in any route outside `lib/money.js` |
| 6 | A route moved to the edge runtime would break `$transaction` invisibly | A test refusing `runtime = 'edge'` in any route |
| 53, 81 | The relation and eligibility guards were textual and drop-unaware | The index guard now honours `DROP INDEX` and separates unique from plain indexes, so a replaced index is not read as coverage |
| 35, 79 | Rows written under the old rules were never repaired | A data migration: deactivates rejected-but-active stores, clamps out-of-range coupon discounts, and backfills `Order.couponCode` from the JSON snapshot |

## The layer the audit could never reach

| # | What was added |
| --- | --- |
| 29, 56, 63 | **A component suite** (`tests/component_tests.test.jsx`, jsdom). Every client finding until now was proven against the Redux store or a pure function, never a rendered component. It covers: `ProductCard` under both the aggregate and the full-review shape, and against `NaN` for an unreviewed product; `OrderSummary`'s total coming from the shared pricing function; **the button actually disabling in flight**; and **the same idempotency key surviving two clicks** — the property the whole server-side deduplication depends on |

## Verification

| Check | Result |
| --- | --- |
| Full suite | **500 passed**, 3 files (was 441 at the end of F-27; 176 at the start of the audit) |
| `npm run lint` | Clean, on the ESLint CLI |
| `npm audit --audit-level=high` | exit 0 |
| `npm run build` | Compiled successfully **with no database environment at all** |
| `npx prisma validate` | Valid; 7 migrations, all additive or annotated |
| Structural guards | Every one re-run after each batch; several were strengthened when a mutation escaped |

---

# 17. Deferred: Environment and Credential Work

Left by instruction. Each needs an environment variable, a credential, an
external service or a live deployment — none can be closed from the repository,
and none is guesswork: the code side of every one is already in place.

| # | Item | What remains | Blocking? |
| --- | --- | --- | --- |
| 44, 43, 45 | **Alerting, error tracking, metrics** (F-14) | The events exist and are countable — `payments_reconciled`, `webhook_duplicate`, `card_checkout_refused`, `rate_limited`, `api_error` with a request id. Nothing watches them. Wire an error tracker (DSN) and write the §13 alerts | **Yes — the highest-value remaining item.** Reconciliation now *detects* a lost payment; nobody is told |
| 93 | **Shared rate limiter** (F-27) | The in-repo limiter is per-instance, so the real ceiling is `limit × warm instances`. Put Upstash or the Vercel firewall in front of the five authenticated routes and the three public ones | **Yes, for a public deployment with open seller registration** |
| 49 | **Promote the CSP** (F-15) | Load the deployed app against the real Clerk tenant, confirm no violations across sign-in, checkout and image loading, then rename `Content-Security-Policy-Report-Only` | No — but it defends nothing until done |
| 24, 26 | **Stale webhook secret** (F-08) | Presence is checked; correctness cannot be. Run `npm run check -- --production` before release, and rely on reconciliation to catch what a wrong secret loses | No |
| 25 | **Stripe option shown when card payment is unavailable** (F-08) | The server refuses with a clear 503. Hiding the option needs the client to know a server-side variable — a second source of truth that can drift | No |
| 16 | **Clerk→Inngest integration** (F-06) | Provisioning no longer depends on it. Profile updates and deletions still do. Verify in the Clerk dashboard | No |
| 36, 38 | **Admin identity** (F-12) | Still `ADMIN_EMAIL`. Moving it to Clerk private metadata or a roles table needs tenant configuration | No |
| 90 | **Migrate workflow unexercised** | Needs `DATABASE_URL` / `DIRECT_URL` secrets and a `production` environment | No |
| 87 | **Vercel runtime** (F-25) | `engines.node: 22.x` is the documented mechanism; confirm the build log honours it | No |
| 19, 23, 39, 48, 60, 68 | **Everything needing a live database** | FK behaviour, transaction rollback, index impact, the healthy `/api/health` path, the concurrent idempotency race, and query timings. All are inferred from schema and contract | No — but §11 stays open until a database exists |

**Also outstanding, and not environment-bound:** applying the migrations at all.
Seven exist, none has ever run. `npm run migrate:status` before the first deploy.
