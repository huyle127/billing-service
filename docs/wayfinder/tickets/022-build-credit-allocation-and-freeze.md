# 022 Build the credit ledger: allocation, adjustment, and wallet freeze

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/credit/ -->
<!-- blocked-by: 021 -->

## Question

The rest of the credit module: the primitives every billing flow calls into.

**Use `/tdd`** — same reasoning as 021.

- **`allocate(tx, …)` accepts the caller's transaction client.** Allocation must land in the same
  transaction as subscription activation and the payment record, so the signature has to admit a
  transaction rather than opening its own. Ticket 004's transaction rule: the service owning the flow
  opens it, participants accept it.
- **Allocation idempotency is an opaque `allocationKey`** — subscription plus month — stored in
  `CreditTransaction.idempotencyKey` under the same unique constraint consumption uses. Ticket 014
  forced this: the earlier `(stripeInvoiceId, periodStart)` composite could not cover the
  invoice-less paths, and there are two of them — the registration grant and the annual cron. The
  `stripeInvoiceId` and `periodStart` columns stay on the model for reconciliation, not as the key.
- **The credit module does not build the key.** The billing module does, and passes it in. This is
  what keeps `credit` a leaf.
- **`adjust()` targets the add-on ledger only**, and the rule is enforced **in the service, not the
  controller**, so it holds for every caller rather than only for the HTTP one.
  `POST /v1/admin/users/:userId/credits/adjust` lives here; the rest of the admin surface is ticket
  029.
- **`freeze()` / `unfreeze()`** over `WalletStatus`. A frozen wallet blocks **both** ledgers. The
  freeze is a gate on consumption and never a mutation of balances: **add-on credits survive it
  intact, are not deducted, and never expire.**
- **`RESET`** for the forfeiture of subscription credits on expiry — the caller is ticket 025.

**Trap.** Non-negative CHECK constraints on both balance columns already exist, applied by migration
`20260804153434_add_ledger_constraints` and verified by violation in ticket 001. A negative
adjustment must not be able to drive a balance below zero — assert it by attempting the violation,
not by trusting the code path.

## Requirement clauses closed

Section 6:

- Add-on credits survive a freeze and never expire
- Allocation is idempotent on subscription and month
- Admin adjustments target add-on credits only
