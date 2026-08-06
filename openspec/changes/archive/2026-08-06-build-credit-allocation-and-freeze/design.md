## Context

`src/credit/` currently holds consumption and reversal, built by ticket 021: a service that opens its
own transaction, locks the wallet row with `SELECT … FOR UPDATE`, and writes one `CreditTransaction`
per ledger it touches. This change adds the operations that put credits *in* and the gate that stops
them being spent, all of which are called by billing flows that own a transaction of their own.

The decisions this change inherits and does not revisit: the allocation trigger and the opaque
allocation key ([ticket 016](../../../docs/wayfinder/tickets/016-decide-credit-allocation-trigger.md),
amended by [014](../../../docs/wayfinder/tickets/014-decide-free-plan-modelling.md)), the transaction
rule and the leaf position of `credit`
([004](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)), the schema and its
constraints ([007](../../../docs/wayfinder/tickets/007-design-persistence-schema.md)), and the
identity seam and transaction timeouts found by
[021](../../../docs/wayfinder/tickets/021-build-credit-consumption.md).

## Goals / Non-Goals

**Goals:**

- `allocate`, `reset`, `freeze`, `unfreeze` as primitives that join a caller's transaction, and
  `adjust` as an operation with its own HTTP entry point.
- One place that decides what a grant does to a balance, so tickets 023, 025, 027 and 028 do not each
  answer it.
- The admin adjust route reachable from `credit` without an import edge back to `auth`.

**Non-Goals:**

- *When* to allocate, freeze, or unfreeze. Reading `billing_reason`, detecting payment through
  `invoice.status`, and persisting the paid-through boundary are ticket 027; the annual cron is 028;
  expiry is 025. This change ships the primitives and their callers stay `todo`.
- Building allocation keys. The billing module builds them; the ledger stores them.
- `GET /v1/me/wallet` (ticket 031) and the rest of the admin surface (ticket 029).
- Any schema change. See below.

## Decisions

### Allocation takes the transaction; adjustment opens one

`allocate(tx, …)`, `reset(tx, …)`, `freeze(tx, …)` and `unfreeze(tx, …)` all take the transaction
client first, because every caller is a billing flow that already owns one — activation, the payment
record, and the `SubscriptionEvent` must land with the grant or not at all. `adjust()` is the
exception: its only caller is its own HTTP route, so it opens the transaction itself, exactly as
`consume` does.

The wallet is locked with the existing `lockByUserId` in every one of them. Allocation contends with
consumption for the same row, and reading a balance to compute `balanceAfter` without the lock would
race a concurrent consumption into a wrong recorded balance.

The lock is also what makes the idempotent replay reachable, and it has to be. `consume` answers a
`P2002` by retrying its whole transaction, which `allocate` cannot do: it runs inside the caller's
transaction, and a unique violation leaves Postgres in an aborted transaction where every later
statement fails `25P02` — there is no way to read the existing row and answer with it. Under the lock
the second caller waits for the first to commit, then finds its row and replays. A `P2002` that
survives the lock is a **cross-wallet** key collision, because `@@unique([idempotencyKey, ledger])` is
global rather than per-wallet, and there a replay would answer with another user's row. It surfaces.

*Alternative rejected:* letting `allocate` open its own transaction and having callers call it after
committing. That splits activation from its grant, which is the atomicity requirements §5 demands.

### A replacing allocation writes two rows in one call

The user settled the ambiguity between "Subscription Credits reset according to the Subscription plan
and billing cycle" and the mid-cycle rule's "in addition to what they already hold": **subscription
credits do not roll over.** A renewal lands on the plan amount; a mid-cycle plan change adds.

The ledger cannot tell those apart — it is a leaf and knows nothing about billing periods — so the
caller passes the intent as a flag, and the ledger writes what the flag means:

| Caller | Flag | Rows written |
| --- | --- | --- |
| `subscription_cycle`, annual cron month boundary | replacing | `RESET` for the remainder, then `ALLOCATION` |
| `subscription_update` (mid-cycle plan change) | additive | `ALLOCATION` |
| registration grant, add-on purchase | additive | `ALLOCATION` |

Both rows are written **inside one call**, not by a caller doing `reset()` then `allocate()`. Two
calls are not idempotent as a pair: a retry replays the allocation as a no-op but resets again,
zeroing a balance that was already granted. One call under one key makes the pair replay together.

The `RESET` leg carries **no idempotency key**. Both rows sit on the subscription ledger, so a shared
key collides on `@@unique([idempotencyKey, ledger])` and the pair becomes unwritable — the same shape
as ticket 021's finding that reversal rows cannot carry the consumption's key. The `ALLOCATION` row
carries the key, so the constraint still decides whether the pair happens.

*Alternative rejected:* one `ALLOCATION` row for the net delta. A renewal from 30 leftover to 200
would record `+170`, which is not what happened and would make the transaction history unreadable as
an audit trail.

### `adjust` has no ledger parameter

The add-on-only rule is enforced by the signature: there is no argument that could name the
subscription ledger, from HTTP or from any future caller. The DTO declares `amount` and `reason` and
nothing else, so the global validation pipe rejects a body that names a ledger rather than ignoring
it.

An adjustment that would drive the balance below zero is refused with `400` and a new error code
`ADJUSTMENT_EXCEEDS_BALANCE`. It is a caller fault: the admin asked for something the ledger cannot
do, and a `200` would leave them believing it happened. The code is added to the `ErrorCode` union
rather than reusing `VALIDATION_FAILED`, because the request was well-formed and only the wallet's
state made it impossible. It is deliberately *not* the `INSUFFICIENT_CREDITS` decline reason: ticket
021 kept decline reasons out of `ErrorCode` because they are a `200` response contract, and mixing
them would blur that line.

### Freeze sets status and nothing else

`freeze` writes `WalletStatus` and no `CreditTransaction` row — no balance moved, and a row that
records no movement is noise in a money ledger whose history is the audit trail. The audit record for
a freeze is the `SubscriptionEvent` the lifecycle machine writes in the same transaction.

A freeze gates **consumption only**. Allocation, adjustment and reset apply to a frozen wallet,
because ticket 027's recovery path unfreezes and allocates the next period in one transaction, and
requiring a particular order there buys nothing.

Both operations are idempotent: freezing a frozen wallet is a no-op, because the callers are webhook
handlers and the same event can arrive twice.

### `@Roles` and `RolesGuard` move to `common/identity/`

`POST /v1/admin/users/:userId/credits/adjust` lives in `credit`, and `src/credit/credit-seam.spec.ts`
fails if any file under `src/credit/` imports from `auth`. So the marker decorator and its guard move
to `common/identity/` beside `AuthenticatedUser`, `@CurrentUser()` and `@Public()`, and `RolesGuard`
is registered as a second `APP_GUARD` in `auth.module.ts` — ticket 021's finding, applied again: a
guard registered in the module that owns it means any graph containing `auth` is authorised by
definition, including test harnesses that compose modules directly.

`test/auth-http.spec.ts` currently declares `@UseGuards(JwtAuthGuard, RolesGuard)` on its probe
controller. That becomes redundant and is removed, which is itself the assertion that global
registration works.

*Alternative rejected:* an admin module outside `credit` holding the route. It separates a controller
from the only service it calls, and ticket 022 places the route here.

### No schema change, no migration

`CreditTransaction` already has `idempotencyKey`, `reason`, `stripeInvoiceId` and `periodStart`;
`CreditTransactionType` already has `ALLOCATION`, `ADJUSTMENT` and `RESET`; `CreditWallet` already has
`status`; `@@unique([idempotencyKey, ledger])` and both non-negative `CHECK` constraints are applied
by migration `20260804153434_add_ledger_constraints` and were verified by violation in ticket 001.
Nothing here needs a column, so no migration is generated. Should that turn out to be wrong during
implementation, it ships as a migration generated with
`prisma migrate diff --from-config-datasource --to-schema` and applied with `prisma migrate deploy` —
never `db push`.

## Risks / Trade-offs

- **A caller builds two different keys for one month** → the ledger grants twice, by design; it
  enforces uniqueness, not meaning. Mitigated where the keys are built, in ticket 027, and stated as a
  scenario here so the boundary is documented rather than assumed.
- **A caller forgets the replacing flag on a renewal** → credits silently roll over, which is a
  balance that is too generous and therefore unlikely to be reported. Mitigated by the flag being
  required rather than defaulted, so the choice cannot be made by omission.
- **Allocation contends with consumption for the wallet lock** → a burst of consumption delays a
  webhook-driven grant. The ledger's `maxWait` and `timeout` from ticket 021 already cover the queue;
  the `pg` pool's ten connections remain the real ceiling, unchanged by this change.
- **Registering `RolesGuard` globally could close routes that never declared a role** → mitigated by
  the guard returning `true` when no role is marked, which is its current behaviour, and asserted by a
  scenario rather than assumed.
- **A `RESET` row with no idempotency key cannot be replayed on its own** → correct and intended: it
  is replayed as half of a pair whose other half carries the key. It is also why the two rows must be
  written by one call.
