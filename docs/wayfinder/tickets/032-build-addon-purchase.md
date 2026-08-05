# 032 Build add-on credit purchase

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 027, 029, 031 -->

## Question

`POST /v1/me/addons/purchase` — the only path that grants credits without a subscription behind it.

- A one-time Stripe payment against the package's Price. Provisioning is called defensively first
  (023), since a purchase needs a Stripe Customer.
- **Credits are granted only after Stripe confirms payment success**, never optimistically at purchase
  time. This is the whole rule of §7 and the one thing that can lose money if it is got wrong.
- The grant arrives through the webhook pipeline (024) and lands as an `ALLOCATION` on the **add-on**
  ledger, in the same transaction as its `PaymentTransaction`.
- Add-on credits **never expire, never reset**, survive a wallet freeze (022), and are drawn only
  after subscription credits are exhausted (021).
- Add-on purchases are not refundable. Refund workflow is out of scope (§11) — Stripe creates no
  `Refund` object unless we explicitly request one, and we never do.

**Coverage gap to fix as part of this ticket.**
[`requirement-coverage.md`](../../testing/requirement-coverage.md) has **no Section 7 table at all**,
so every add-on purchase clause is currently untracked — including "granted only after successful
payment confirmation", which is the highest-value assertion in this ticket. Add the section, then
satisfy it.
