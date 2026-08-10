# 034 Determine the Stripe account's billing mode

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-05) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Is account `acct_1TlhMSFaNFL0w4nv` in `classic` or `flexible` `billing_mode`?

Ticket 003 could not determine which mode new accounts default to, and the map has carried it as fog
ever since. It is sharp enough to ticket now and small enough to finish in minutes: read it from the
account object or from an existing test subscription through the API, using the secret key already in
`.env`.

**Why it matters.** `billing_mode` materially changes proration credit amounts. Price-change
migration (ticket 030, merged into 029 on 2026-08-10) deliberately chose *no* proration, so that
path is unaffected — but
`PATCH /v1/me/subscription` in ticket 031 is a genuine mid-cycle plan change and does prorate. Its
expected amounts cannot be asserted until the mode is known, which is why 031 blocks on this.

Record the answer, and record where it was read from, so a later reader can re-check it if the
account is ever recreated.

## Answer

**`flexible`.** Read on 2026-08-05 from `stripe subscriptions list --limit 5` against
`acct_1TlhMSFaNFL0w4nv`. All four existing subscriptions report it, and they were created at two
distinct times weeks apart, so this is the account default for new subscriptions and not a
per-subscription override.

```json
"billing_mode": {
  "type": "flexible",
  "flexible": { "proration_discounts": "included" },
  "updated_at": 1785313229
}
```

**Ticket 003 guessed the shape wrong, and the guess was the dangerous kind.** `billing_mode` is not
the scalar `'classic' | 'flexible'` that ticket assumed — it is an object. A comparison written as
`subscription.billing_mode === 'flexible'` type-checks against a loose SDK type, compiles, and is
always false. Read `billing_mode.type`. This is the same failure shape as the removed `invoice.paid`
boolean: a falsy read that never errors.

**`proration_discounts: "included"`** means discounts are folded into proration calculations. Nothing
in the current design applies discounts, so it changes no expectation today — but it is the field to
revisit if coupons are ever introduced.

**Consequences.**

- Ticket 031's `PATCH /v1/me/subscription` can now have its proration amounts asserted. Flexible mode
  is the newer engine and prorates per subscription item.
- Price-change migration is unaffected, as expected: it chose no proration, so no proration is
  computed on that path at all.
- Ticket 019 should expose `billing_mode.type` as a plain domain value if anything above the adapter
  ever needs it, rather than letting the nested object leak upward.
