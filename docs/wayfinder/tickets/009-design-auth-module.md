# 009 Design the auth module

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: requirements section 9, docs/architecture/stripe-sync.md -->
<!-- blocked-by: -->

## Question

How is the in-repo auth module built so that it works today and can be removed cleanly tomorrow?

The module provides registration, login, bcrypt password hashing, JWT access tokens, and
USER/ADMIN role-based authorization. It exists only to make the service self-contained for
development and demonstration, and is expected to be replaced by an upstream Authentication
Service. Replaceability is therefore a design requirement, not a nicety.

Questions to resolve:

- **Token claims.** What does the JWT carry — subject, role, expiry? Issuer and audience claims are
  **deliberately omitted**: there is a single service, so they would validate nothing. If an upstream
  Authentication Service later serves multiple consumers, they become meaningful and get added then.
- **Verification.** Symmetric secret or asymmetric key pair? Asymmetric costs slightly more now
  and makes the eventual swap far easier, since the upstream issuer keeps the private key.
- **Refresh tokens** — in scope, or are access tokens alone enough for a local service?
- **The three auth modes** from requirements §9: user token, admin token, and an internal API key
  for service-to-service calls such as the cron-triggered allocation. Are these three NestJS
  guards, or one guard with a strategy? How does the internal key path avoid impersonating a user?
- **The replaceability seam** established in 004: what interface does billing code consume, and
  what proves nothing outside the auth module reads its tables?
- Does registration create billing state — a Free subscription, a Stripe customer, a wallet — or
  is that a separate explicit step? Requirements §3 says the Stripe customer is created when the
  initial subscription is created, including the Free one, so the ordering matters.

## Answer

Recorded in requirements §9. This ticket also resolves ticket 005, since both amend that section.

**Three separate cryptographic choices, for three different jobs.** They are easy to confuse and
getting one wrong is a real vulnerability, so they are recorded explicitly:

| Job | Algorithm | Why |
| --- | --- | --- |
| Signing JWTs | HS256 (HMAC-SHA256) | Runs on every request — fast is the requirement |
| Hashing passwords | **bcrypt**, cost 12 | Deliberately slow; the defence when the database leaks |
| Hashing refresh tokens | SHA-256 | High-entropy machine-generated value, not guessable — slowness buys nothing |

Hashing passwords with a fast hash such as SHA-256 would allow billions of guesses per second
against a stolen database. Signing tokens with bcrypt would be meaningless — it is not a MAC — and
its intentional cost would be paid on every request.

**Tokens: HS256, access plus refresh.** Claims are subject, role, expiry — issuer and audience were
dropped earlier as validating nothing in a single-service system. Refresh tokens were not in the
original description of the module, but the credential schema already carries the column and
without them a demo re-authenticates every fifteen minutes. Asymmetric keys were considered and
rejected: the benefit only materialises when an upstream issuer exists, and that issuer brings its
own key distribution, making the verifier change small.

**OAuth is out of scope.** The reference implementation includes a Google strategy; the module
described for this project does not, and adding it would expand a component built to be deleted.

**Three guards, and one rule that matters more than the structure: the internal API key yields a
service principal carrying no user identity.** Endpoints behind it must never accept "act on behalf
of user X" semantics; they operate on their own scope, such as all subscriptions due for allocation.
If the internal key could assume a user identity, one leaked environment variable would grant access
to every account.

**Replaceability interface:** billing and credit depend only on a verified principal — user
identifier and role — produced by the guard. Nothing outside the auth module reads `AuthCredential`.
Replacement means writing a new guard returning the same shape.

**Credit allocation cron: both triggers, one routine.** An in-process scheduler and an
internal-key-protected endpoint both invoke the same idempotent service method. Running both at once
is harmless — the allocation key from ticket 016 discards the duplicate. This graduates the cron
mechanism out of the map's fog, and it is why `INTERNAL_API_KEY` earns its place in the environment.

**Provisioning** was resolved earlier in this ticket; the full failure-recovery design lives in
`docs/architecture/stripe-sync.md`.

**Registration does not provision billing, and does not contact Stripe.** In one transaction it
creates the User, the Free Subscription, and the Credit Wallet with the first month's credits
already granted — so a dashboard shows plan and balance immediately, and registration survives
Stripe being unavailable. Recorded in requirements §3 under "Provisioning a new user".

**Stripe provisioning runs immediately after registration, not lazily on first billing visit.** This
was an explicit correction: "lazy until the user opens a billing page" was rejected. The Stripe
Customer and Stripe Subscription are created right away, outside the registration transaction and
without blocking the response.

**No job table.** `stripeSubscriptionId IS NULL` on a current Subscription *is* the work queue. One
idempotent provisioning routine is reached from three paths: called directly at the end of
registration, swept by a periodic reconciler, and invoked defensively before any operation needing
a Stripe Customer. An event-bus listener was rejected — a failed listener loses the work silently,
which ticket 004 forbids for anything maintaining an invariant.

A Subscription with no Stripe identifier is a valid intermediate state, not an error.

**The full failure-recovery design is in `docs/architecture/stripe-sync.md`**, written in response
to a challenge on this ticket: how to detect unsynced rows without scanning the subscriptions table.
The answer is a **partial index** containing only pending rows, so reconciler cost is proportional
to the backlog rather than table size — that is what makes the no-job-table design viable at scale.
It also settles outbox-versus-reconciliation (outbox is correct only when the work is *not*
derivable from domain state; here it is), three-layer idempotency against duplicate Stripe objects
(idempotency keys, our IDs in Stripe metadata for when those keys expire, and unique constraints),
and the rule that **webhooks never create domain rows** — they attach or defer, which is what
prevents duplicates when an event overtakes our own API call.

**Still open on this ticket:** the token scheme (symmetric versus asymmetric, refresh tokens in or
out), the three access paths and how the internal API key avoids impersonating a user, and the
precise interface billing depends on so the module can be deleted cleanly.
