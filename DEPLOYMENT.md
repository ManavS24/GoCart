# Deployment

Everything still outstanding before and after this application takes real
traffic. Completed work is not listed here — it is in the code, the tests and
the git history. Extracted from the production-readiness audit (commit
`d8e19a8`), which recorded the full finding-by-finding evidence.

---

## 1. Blocking — before any production traffic

- [ ] **Wire an error tracker and define the alerts in §5.** The events exist and
  are countable — `payments_reconciled`, `card_checkout_refused`,
  `rate_limited`, `api_error` with a request id — but
  nothing watches them. Reconciliation now *detects* a payment taken without an
  order; nobody is told. This is the highest-value item left.

- [ ] **Put a shared rate limiter in front** (Vercel firewall or Upstash). The
  in-repo limiter is per-instance, so the real ceiling is `limit × warm
  instances`, and anonymous endpoints have no budget at all. Required before the
  deployment is publicly reachable with open seller registration.

- [ ] **Apply the migrations.** Eight exist; none has ever run anywhere. Run
  `npm run migrate:status` before the first deploy, then the *Migrate database*
  workflow. It needs `DATABASE_URL` / `DIRECT_URL` repository secrets and a
  `production` environment, neither of which is configured yet.

- [ ] **Run `npm run check -- --production`.** The gate is opt-in and promotes
  deferred variables to required, so a deploy cannot go out half-configured.

- [ ] **One-off data fix**, after migrating:
  `UPDATE "Store" SET "isActive" = false WHERE status = 'rejected';` — for stores
  rejected before rejection began switching them off.

---

## 2. Environment and credentials

Each needs a variable, a credential, an external service or a live deployment.
The code side of every one is already in place.

| Item | What remains | Blocking |
| --- | --- | --- |
| Alerting, error tracking, metrics | See §1 | **Yes** |
| Shared rate limiter | See §1 | **Yes** |
| Promote the CSP | Load the deployed app against the real Clerk tenant, confirm no violations across sign-in, checkout and image loading, then rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. It defends nothing until then | No |
| Online option shown when payment is unavailable | The server refuses with a clear 503. Hiding the option needs the client to know a server-side variable — a second source of truth that can drift | No |
| Clerk→Inngest integration | Provisioning no longer depends on it; `clerk/user.updated` and `clerk/user.deleted` still do, so without it profile data goes stale and deleted accounts keep their rows. Verify in the Clerk dashboard | No |
| Admin identity | Still `ADMIN_EMAIL`. Moving it to Clerk private metadata or a roles table needs tenant configuration | No |
| Vercel runtime | `engines.node: 22.x` is the documented mechanism; confirm the first build log honours it | No |

---

## 3. Engineering follow-ups

Open work that needs no credentials — each is the residue of a fix that went as
far as it usefully could.

- [ ] **Surface `syncError` in the UI.** A failed cart write-back is observable
  in state but no component reads it, so a shopper still gets no signal that
  their cart has stopped saving.

- [ ] **Paginate `/api/products` and aggregate ratings server-side.** The full
  list is load-bearing for shop search and for cart / `OrderSummary` product
  resolution, so this needs server-side search plus an `ids` lookup, coordinated
  across four components.

- [ ] **Migrate money columns to integer minor units or `Decimal`.** `Float`
  storage round-trips exactly today and is not producing error, so this is a
  latent hazard rather than an active defect — but any future arithmetic that
  bypasses `lib/money.js` reintroduces the class.

- [ ] **Write an on-call runbook** for: payment taken but order unpaid; the
  reconciliation sweep stalled; database unreachable.

- [ ] **Consider adding the webhook back.** Confirmation is currently a
  five-minute poll, which is the shopper's wait to see a paid order and the
  window in which a cart stays full after payment. The ledger table and the
  idempotent update it needs are still in place, so this is additive.

- [ ] **Confirm Neon backups / PITR are enabled** and rehearse a restore.

---

## 4. Unverified — requires a live environment

Nothing below was closable from the repository. Each entry states the check.

| Area | Required check |
| --- | --- |
| Migration application | `prisma migrate deploy` against a scratch Neon branch, then `prisma migrate diff` to confirm the schema matches |
| Seed script | `npm run seed` twice against a scratch branch, to confirm idempotency and that ImageKit `overwriteFile` behaves as documented |
| `npm run check` database half | Run with real credentials; confirm it fails correctly against a suspended Neon project |
| Admin admission | Confirm the real admin account *is* admitted. Authorization resolves the primary address by id and requires `verification.status === 'verified'`, so a wrong model of the Clerk shape now locks an admin out rather than letting an attacker in |
| Razorpay payment link creation | The request and response shape are written against the SDK's surface and Razorpay's documentation, never against a live call. Create one order in test mode and confirm the link opens, the amount is right, and `notes` come back on `paymentLink.all` |
| Reconciliation against live data | Pay a test link, then confirm the next sweep marks the order paid and clears the cart. This is the only path that confirms a payment |
| Clerk → Inngest user sync | Confirm the integration exists, then measure the lag between sign-up and the `User` row appearing |
| Inngest function registration | Sync at `/api/inngest`, confirm all six functions register, and verify `deleteCouponOnExpiry`'s `sleepUntil` fires |
| Clerk `plus` plan | Verify free shipping and member-only coupons resolve for both plan states, and that `has` is present on every `getAuth` result |
| Index impact | `EXPLAIN ANALYZE` the seller dashboard and buyer order queries at ~10k orders; confirm the planner uses the composite indexes rather than a sequential scan |
| Production headers and TLS | Re-run the header check against the live Vercel URL; Vercel supplies HSTS but not the rest |
| Node 22 parity | The suite has never executed on 22 — CI does this on every push, so the first green CI run closes it |
| Load behaviour | Load test `/api/products` and checkout at expected peak |

---

## 5. Monitoring to configure

**Alert (page someone):**

- **No `payments_reconciled` event for 15 minutes.** The sweep is the only
  thing that confirms a payment, so a stalled sweep means money is being taken
  and no order is being marked paid. This is the single most important alert.
- Orders with `paymentMethod = 'RAZORPAY'` and `isPaid = false` older than 30
  minutes, count > 0.
- Razorpay captured-payment count vs. application paid-order count, hourly —
  the authoritative reconciliation.
- Database connection errors, any occurrence.
- 5xx rate on `/api/orders` > 1%.

**Dashboard (review daily):**

- Checkout funnel: `POST /api/orders` → payment link created → order marked
  paid by the sweep. A widening gap is the payment-loss symptom.
- p95 latency on `/api/products`, `/api/orders`, `/api/store/dashboard`.
- Neon connection count and cold-start frequency.
- Inngest function success rate.
- `P2003` / `P2025` Prisma error counts.
- ImageKit and OpenAI error rates and spend.
- `User.cart` row size distribution — cart abuse detection.
- Orders with `total <= 0` — should be zero.

**Verify in the first hour after deploy:**

- `/api/health` returns healthy with database connectivity.
- One end-to-end COD order and one end-to-end online order, confirmed paid by
  the reconciliation sweep.
- Admin console reachable by the `ADMIN_EMAIL` account and refused for a second
  test account.
- A new sign-up produces a `User` row, then completes a checkout.
- Storefront renders with the seeded catalogue.

---

## Release procedure

1. Snapshot the Neon branch (see README).
2. Run the *Migrate database* workflow.
3. Deploy.

That order is safe only because every migration is additive — the previous
release keeps working against the new schema. `tests/unit_tests.test.js`
enforces it, so a non-additive migration cannot reach `main` unannotated.

Rolling back is a code rollback plus, if needed, a Neon branch restore: there
are no down migrations by design.
