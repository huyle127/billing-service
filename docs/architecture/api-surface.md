# API Surface and Error Model

All routes are prefixed `/v1`. Versioning is adopted from the start because the credit consumption
endpoint is consumed by other applications, and changing its contract later without a version would
break them silently.

## Response conventions

**Business outcomes return 200 with a result object. Client and server faults use status codes.**

The boundary matters more than the rule, because "always return 200" would otherwise swallow real
faults:

| Kind | Example | Response |
| --- | --- | --- |
| Business outcome | insufficient credits, wallet frozen | `200` with `success: false` and a reason |
| Client fault | malformed body, unknown plan code, missing field | `400` |
| Authentication | absent or invalid token | `401` |
| Authorization | user token on an admin route | `403` |
| Missing resource | unknown subscription id | `404` |
| Server fault | database or Stripe unreachable | `5xx` |

Successful responses return the resource directly. Fault responses use one envelope:

```json
{
  "error": {
    "code": "PLAN_NOT_FOUND",
    "message": "No active plan with code 'pro_weekly'",
    "details": {}
  }
}
```

`code` is the stable contract. `message` is for humans and may change.

**Declines must be measured.** Because a decline carries a 200, no gateway, log aggregator, or
dashboard can infer it from the status code. The service emits a counter for every declined
consumption, labelled by reason. Without it, a user refused a thousand times looks identical to a
thousand successes.

## Validation

Request bodies are validated declaratively by DTO decorators, applied by a global pipe. Controllers
perform no manual validation and contain no business logic; a controller that inspects a field to
decide behaviour has taken on business logic and belongs in a service.

Validation failure is a client fault and returns `400`.

## Authentication endpoints

Public, except logout. Provided by the in-repo auth module, which is expected to be replaced by an
upstream Authentication Service.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/register` | Create a user; returns the user, not a session |
| `POST` | `/v1/auth/login` | Exchange email and password for an access and a refresh token |
| `POST` | `/v1/auth/refresh` | Exchange a refresh token for a new pair; the old one stops working |
| `POST` | `/v1/auth/logout` | Requires a user token. Clears the stored refresh hash |

Access tokens are short-lived and carry subject, role, and expiry. Refresh tokens rotate on every
use, and only their SHA-256 hash is stored, so logout and revocation are possible. One hash is stored
per user, so a second login ends the first session.

Login refuses an unknown email and a wrong password with the same `401` and the same message.
Registering an email that already exists is a client fault and returns `400`.

## User endpoints

Require a user token. All act on the caller's own identity — none accept a user id.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/me/subscription` | Current subscription with plan and period |
| `GET` | `/v1/me/wallet` | Both credit balances and wallet status |
| `GET` | `/v1/me/history` | Billing history, filtered and paginated |
| `POST` | `/v1/me/subscription` | Subscribe to a paid plan |
| `PATCH` | `/v1/me/subscription` | Change plan or billing cycle |
| `DELETE` | `/v1/me/subscription` | Cancel; access continues to period end |
| `GET` | `/v1/me/payment-methods` | List stored payment methods |
| `POST` | `/v1/me/payment-methods` | Attach a payment method |
| `DELETE` | `/v1/me/payment-methods/:id` | Detach |
| `POST` | `/v1/me/addons/purchase` | Buy an add-on credit package |
| `GET` | `/v1/plans` | Public catalog of active plans |
| `GET` | `/v1/addon-packages` | Public catalog of active packages |

The dashboard reads `/v1/me/subscription` and `/v1/me/wallet`. Both are served from the database
alone, so they answer immediately after registration and do not depend on Stripe having been
reached yet.

## Credit consumption

The hot path, called by other applications rather than by a browser. Both routes require a user
access token and act on that token holder's wallet; neither accepts a user id, and a body carrying
one is rejected by the global validation pipe.

```
POST /v1/credits/consume
  { "amount": 10, "idempotencyKey": "job-8f21c4", "reason": "image-generation" }

200 { "success": true,  "consumed": { "subscription": 10, "addon": 0 },
                        "balance": { "subscription": 40, "addon": 0 },
                        "transactions": [ { "id": "…", "ledger": "SUBSCRIPTION", "amount": -10 } ] }

200 { "success": false, "reason": "INSUFFICIENT_CREDITS",
                        "balance": { "subscription": 3, "addon": 0 },
                        "required": 10 }

200 { "success": false, "reason": "BILLING_FROZEN",
                        "balance": { "subscription": 40, "addon": 0 } }
```

**The success response lists every row it wrote, not one id.** A consumption drawing on both ledgers
writes one row per ledger — that is what the composite uniqueness constraint exists for — so a single
`transactionId` could only ever name one of them and would hide the other from any caller
reconciling against the ledger. Amounts are the stored row amounts, negative for a consumption.

**A decline omits `transactions` entirely.** It wrote no row, and an empty array would suggest rows
exist that were merely not listed.

**Credits are deducted before the caller does its work.** Deducting afterwards would let ten
concurrent requests against a balance of five all complete before any balance check bit — the
resources would already be spent.

**The idempotency key is required.** A retry after a timeout must charge once. The key is stored on
the transaction under a unique constraint, so the guarantee survives concurrent retries rather than
depending on application logic.

**What a replay returns.** The constraint decides whether a second charge happens; this decides what
the caller sees, and without it the constraint violation would surface as a `5xx`.

| Second call | Response |
| --- | --- |
| Same key, same amount | `200` with the **original** result — the first call's `transactionId` and the balances as they were then |
| Same key, different amount | `400` with `IDEMPOTENCY_KEY_REUSED` |

A retry after a timeout must be indistinguishable from the success it is replaying, which is why the
first row is a `200` and not a conflict. The second row fails loudly on purpose: one key now means
two different operations, which is a caller bug, and returning the first result silently would
undercharge with nothing to indicate it. Both behaviours match Stripe's and Square's, so integrating
applications already expect them.

```
POST /v1/credits/reverse
  { "idempotencyKey": "job-8f21c4" }

200 { "restored": { "subscription": 10, "addon": 0 },
      "balance": { "subscription": 50, "addon": 0 },
      "transactions": [ { "id": "…", "ledger": "SUBSCRIPTION", "amount": 10 } ] }
```

Returns credits to the ledger they were drawn from, as a `reversal` transaction linked to the
original. A consumption can be reversed at most once, enforced by a unique constraint. A repeated
reversal returns the first one's result, for the same reason a repeated consumption replays.

**The reversal response carries no `success` field.** Reversal has no business outcome to decline: a
frozen wallet is reversed anyway, and a key with no consumption behind it is a `404`. Its result is
carried by the status code alone.

Reversal rows carry no idempotency key. Copying the consumption's key would collide with the
consumption's own row on the composite constraint; the link is `reversesId`, and that is what bounds
a consumption to one reversal.

Reversal exists because `adjustment` is admin-authorised and restricted to Add-on Credits — without
it there is no legitimate way to return Subscription Credits after a failed operation.

## Admin endpoints

Require an admin token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/v1/admin/plans` | List, create — creates the Stripe Product and Price |
| `PATCH` `DELETE` | `/v1/admin/plans/:id` | Update credits or price; archive |
| `GET` `POST` | `/v1/admin/addon-packages` | List, create |
| `PATCH` `DELETE` | `/v1/admin/addon-packages/:id` | Update; archive |
| `GET` | `/v1/admin/users/:userId/billing` | Subscription, wallet, and history for one user |
| `POST` | `/v1/admin/users/:userId/credits/adjust` | Adjust **add-on credits only** |

The adjustment route rejects any attempt to target subscription credits. That restriction is
enforced in the service, not the controller — it is a domain rule, and routing it through the
controller would leave it unenforced on any other caller.

A price change on `PATCH /v1/admin/plans/:id` creates a new Stripe Price and schedules existing
subscribers for migration at their next renewal. It returns immediately; migration is driven by the
state-derived reconciler described in the Plan Catalog Management section of the requirements.

## Internal endpoints

Require the internal API key. They yield a service principal with **no user identity** and never
accept "act on behalf of user X" semantics.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/internal/allocations/run` | Run due credit allocations |
| `POST` | `/v1/internal/provisioning/run` | Sweep subscriptions awaiting Stripe objects |

Both are idempotent and invoke the same routines the in-process scheduler calls. Running them
concurrently with the scheduler is harmless.

## Webhook endpoint

```
POST /v1/webhooks/stripe
```

Authenticated by Stripe signature, not by token — the one route that bypasses the auth guards
entirely. Excluded from the global JSON body parser, because signature verification needs the raw
body. Returns 2xx as soon as the event is persisted; processing is asynchronous.

## Billing history

One endpoint with filters rather than several, because the requirements define history as a single
derived view aggregated from three ledgers, and splitting it per source would push the merging work
onto every client.

```
GET /v1/me/history?type=payment,credit&from=2026-01-01&limit=50&cursor=…
```

**Cursor pagination, not offset.** History grows indefinitely and new rows arrive at the head, so
offset pagination would skip or repeat entries as a user pages through. The cursor encodes the
sort position of the last row returned.
