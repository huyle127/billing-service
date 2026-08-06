# 022 Build the credit ledger: allocation, adjustment, and wallet freeze

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-06) -->
<!-- assignee: -->
<!-- output: src/credit/ -->
<!-- blocked-by: 021 -->
<!-- change: build-credit-allocation-and-freeze -->

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

## Settled while claiming (2026-08-06)

Three things the ticket left open, answered before the change was written.

- **Subscription credits do not roll over.** A renewal replaces the subscription balance with the
  plan's allocation for the new cycle. The requirements read as a contradiction — §6 says credits
  "reset according to the Subscription plan and billing cycle" while the mid-cycle rule grants "in
  addition to what they already hold" — and this resolves it: **replacing on a cycle boundary,
  additive on a mid-cycle plan change**. The ledger is a leaf and cannot tell the two apart, so the
  caller passes the intent as a required flag, and a replacing allocation writes its `RESET` and its
  `ALLOCATION` legs in **one call** — two calls are not idempotent as a pair, because a retry replays
  the grant as a no-op but resets again. The `RESET` leg carries no idempotency key or it collides
  with the `ALLOCATION` leg on `@@unique([idempotencyKey, ledger])`, the same shape as ticket 021's
  reversal finding.
- **An over-large negative adjustment is a `400`**, under a new `ADJUSTMENT_EXCEEDS_BALANCE` code —
  a caller fault, not a business outcome, so it is not an `INSUFFICIENT_CREDITS` decline. Ticket 021
  kept decline reasons out of the `ErrorCode` union deliberately, because they are a `200` response
  contract.
- **`@Roles()` and `RolesGuard` move to `common/identity/`** and the guard is registered as a second
  `APP_GUARD` in `auth.module.ts`. The admin adjust route lives in `credit`, which cannot import from
  `auth` without breaking `credit-seam.spec.ts` — the seam ticket 021 opened for `@Public()` and
  `@CurrentUser()`, closed the same way for roles.

## Answer

Shipped through OpenSpec change `build-credit-allocation-and-freeze`. **All four clauses closed**,
across 20 new tests; the suite stands at 128 across 19 files. No schema change and no migration —
`ALLOCATION`, `ADJUSTMENT` and `RESET`, both nullable reconciliation columns, `WalletStatus` and both
constraints were already in place, exactly as the ticket predicted. No configuration key was added.

**The three things settled while claiming all survived contact.** The replacing flag is required
rather than defaulted, so a caller cannot roll credits over by omission; the `RESET` leg carries no
idempotency key and both legs are written by one call, so a retry replays the pair together; and the
admin route reaches `@Roles(Role.ADMIN)` through `common/identity/` with `credit-seam.spec.ts` still
green.

**`allocate` cannot translate a `P2002` into a replay, and does not need to.** The ticket's plan
assumed the constraint violation would be caught and turned into the replay, the way ticket 021's
`consume` does. It cannot be: `allocate` runs inside the *caller's* transaction, and a unique
violation puts Postgres into an aborted transaction where every subsequent statement fails `25P02` —
there is no way to read the existing row and answer with it. `consume` gets away with it only because
it owns its transaction and can retry the whole thing.

The guarantee is the wallet lock instead. `SELECT … FOR UPDATE` serialises two callers on one wallet,
so the second waits for the first to commit, then reads its row and replays. What remains reachable
under `@@unique([idempotencyKey, ledger])` is a **cross-wallet** key collision — the constraint is
global, not per-wallet — and there a replay would be wrong, because it would answer with another
user's row. Letting it surface is the correct behaviour, not a gap.

**`grant` was split into `forfeit` and `grant`.** One method writing both the `RESET` and the
`ALLOCATION` made its name cover only half of what it did, and left the honest half unreusable —
`grant` now serves an add-on purchase unchanged, and `forfeit` is what the public `reset(tx, userId)`
sits on, so expiry and a renewal's first leg are one piece of code.

**Two rows written in one transaction share a `createdAt`.** Postgres `now()` is transaction-start
time, so `@default(now())` stamps the `RESET` and the `ALLOCATION` identically and cannot order them.
Their assertions key on `type` rather than row order. Worth knowing before anything downstream tries
to read the ledger back in write order — it needs a sequence or an explicit ordinal, not a timestamp.

## Requirement clauses closed

Section 6:

- Add-on credits survive a freeze and never expire
- Allocation is idempotent on subscription and month
- Admin adjustments target add-on credits only
- A renewal replaces subscription credits; unused credits do not roll over — **a new row**, added to
  `requirement-coverage.md` by this ticket, because the no-rollover rule is required behaviour the
  checklist did not track
