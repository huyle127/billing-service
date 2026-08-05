# 023 Build registration provisioning and the Stripe sync reconciler

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/, src/auth/ -->
<!-- blocked-by: 019, 020, 022 -->

## Question

How a new user gets entitlement instantly and a Stripe object shortly afterwards. Designed in
[`stripe-sync.md`](../../architecture/stripe-sync.md); this builds it.

The governing rule: **our database is authoritative for entitlement, Stripe for money.** A user who
registers during a Stripe outage gets Free access and credits immediately; only their ability to
*pay* is deferred.

- **Extend the registration transaction from 020.** One transaction creates `User`,
  `AuthCredential`, `BillingCustomer` with `stripeCustomerId = NULL`, the Free `Subscription` with
  `stripeSubscriptionId = NULL`, the `CreditWallet`, and the Free plan's monthly credits already
  allocated under this month's allocation key. **No Stripe call inside the transaction.**
- `BillingCustomer` is created **eagerly with a null id**, not once Stripe answers. If the row only
  appeared on success, a failed provisioning would leave nothing behind to find, and detecting
  affected users would require scanning `User` — reintroducing the full-scan problem the partial
  indexes exist to solve.
- **Provisioning is one idempotent routine reached from three triggers:** called at the end of
  registration without blocking the response; swept by the periodic reconciler; called defensively
  before any operation that requires a Stripe Customer (ticket 031's upgrade and 032's add-on
  purchase).
- The reconciler reads the partial index already in `prisma/sql/constraints.sql`:
  `stripeSubscriptionId IS NULL AND status IN (…)` ordered by `syncNextAttemptAt`, `LIMIT 50
  FOR UPDATE SKIP LOCKED`. Its cost is proportional to the outstanding backlog, not to table size —
  the property a full scan lacks and the reason no job table is needed.
- `syncAttempts`, `syncNextAttemptAt` (exponential backoff) and `syncError` live inline on the row.
  **No outbox and no job table**: the work is fully derivable from domain state, so the thing that
  needs doing is the thing that records it, and the work cannot be lost.
- **Escalate by age, not by attempt count.** A row pending longer than about an hour is a genuine
  alert — either Stripe has been down that long or our request is malformed and will never succeed.
  Retrying forever in silence is the failure mode to avoid.
- Order is **create in Stripe, then persist locally**, since network calls are barred from
  transactions. Three layers make crossing that window twice harmless: the Stripe idempotency key,
  our metadata searched before create (because Stripe's keys expire in 24 hours), and the unique
  constraint on `stripeCustomerId` — two concurrent provisioners cannot both persist a result, and
  the loser's retry finds the work done.
- `POST /v1/internal/provisioning/run` behind the internal API key, yielding a service principal
  with no user identity.

**Note the near-miss ticket 014 caught:** the registration grant and the first zero-amount
`invoice.paid` describe the same subscription and the same month. The allocation key is what
discards the second. Do not add a guard for this in application logic — the key already covers it,
and a second mechanism would be a second thing to keep correct.

**Inherited from ticket 020 — the internal API key.** 020 deferred it rather than build a guard whose
only caller was a probe controller in a test. This ticket ships the first endpoint behind it, so it
also builds `InternalKeyGuard` (timing-safe comparison against `INTERNAL_API_KEY`, already in
configuration) and the service principal that carries **no user identifier of any kind** — make that
unrepresentable in the type rather than rejected at runtime.

## Requirement clauses closed

Section 3:

- Registration grants plan and credits without contacting Stripe
- Stripe customer and subscription provisioned immediately after registration
- A subscription with no Stripe id is a valid intermediate state

Section 9, inherited from ticket 020 now that an internal endpoint exists:

- Internal key yields a service principal with no user identity
- Internal endpoints reject "act on behalf of" semantics
