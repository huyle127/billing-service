## Context

`src/` currently holds `main.ts`, `app.module.ts`, and `common/prisma/`. Nothing else exists. This
change is cross-cutting by definition — it is the shared floor eight later changes stand on — so it
warrants a design note even though it introduces no new dependency and no schema change.

The decisions it rests on are already closed and are not reopened here: module shape and the clock
seam in [004 Design module boundaries and layering](../../../docs/wayfinder/tickets/004-design-module-boundaries.md),
the error model and `/v1` in [011 Design the API surface and error model](../../../docs/wayfinder/tickets/011-design-api-surface.md),
and the test harness constraints in [010 Decide the testing strategy](../../../docs/wayfinder/tickets/010-decide-testing-strategy.md).

## Goals / Non-Goals

**Goals:**

- One clock, one error envelope, one configuration surface, one counter interface, reachable by
  every module through Nest DI.
- Make the three load-bearing mistakes impossible to make quietly: an un-injected clock, an
  unstable error code, and a consumed webhook body.

**Non-Goals:**

- No metrics exposition endpoint, no `/health`, no structured logging. The operational surface is
  a separate concern and is still fog on the wayfinder map.
- No authentication, no guards. Those are change `build-auth-module`.
- No schema change of any kind.

## Decisions

**The clock is an interface with two implementations, not a wrapper around `Date`.** A settable
singleton would be simpler, but tests run in one process with `fileParallelism` disabled, so a
mutable global would leak between files. Injection scopes the fake to the testing module that
declares it.

**The lint rule bans `new Date()` by syntax, not by convention.** A convention here decays: the
failure it prevents is silent — a cron that passes every test and never advances — so it is worth
the rule. `common/clock` is the single exempt directory.

**Error codes live as a union type, not free strings.** `code` becomes a public contract the moment
`POST /v1/credits/consume` ships, since other applications branch on `INSUFFICIENT_CREDITS` versus
`BILLING_FROZEN`. A typo in a free string is a broken contract that compiles.

**Configuration validates at boot, not at first use.** A missing `STRIPE_WEBHOOK_SECRET` discovered
when the first webhook arrives is a production incident; discovered at startup it is a failed boot.
Alternative considered and rejected: lazy reads with defaults, which would let the service run in a
misconfigured state that looks healthy.

**Raw body preservation uses NestJS's `rawBody` option, which is global.** *Revised during
implementation.* The original decision was to scope it to the webhook path alone, on the grounds that
no other route should pay for it. On contact with the code that reversed: `main.ts` already created
the app with `rawBody: true`, and scoping it would mean disabling Nest's body parser and hand-wiring
both the raw and the JSON path. That trades a negligible cost — request bodies here are small JSON
DTOs — for custom body handling on the one route whose failure mode is silent. The spec was rewritten
to state the outcome (webhook sees exact bytes, other routes see parsed JSON) rather than the
mechanism.

**The metrics counter ships as an interface with an in-memory implementation.** Choosing an exporter
now would be a guess — the destination is a locally running service with no monitoring stack. The
seam is what change `build-credit-consumption` needs; the exporter can be added behind it later
without touching callers.

## Risks / Trade-offs

- **The in-memory counter loses its values on restart, and nothing reads it.** → Accepted for now,
  and named explicitly so it is not mistaken for working observability. The requirement that
  declines be measured is only half-met until an exporter exists; the wayfinder map carries the
  remaining work as fog under *Observability*.
- **The lint rule will fire on legitimate uses in seed scripts and tests.** → Scope the rule to
  `src/`, excluding `common/clock`, and leave `prisma/` and `test/` out of it.
- **`/v1` as a global prefix will also prefix the webhook route**, so the Stripe endpoint is
  `/v1/webhooks/stripe`. → That is intended and matches the API surface document, but the value
  configured in the Stripe Dashboard and in `stripe listen --forward-to` must match it. Ticket 002
  still has that forwarding check open.

## Migration Plan

None. No schema change, so no migration. Had one been needed it would ship as
`prisma migrate diff --from-config-datasource --to-schema` followed by `prisma migrate deploy` —
never `db push`, and never `migrate dev` in a non-interactive shell.

## Open Questions

*Resolved during implementation.*

- **Which error codes exist at launch?** Five, not the two originally planned: `VALIDATION_FAILED`,
  `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`. The filter catches every exception, so
  it must map `401` and `403` to something — and with only two codes it would have had to label them
  `INTERNAL_ERROR`, which is a lie told to consumers at the exact moment they most need to branch.
  The auth codes ship unused; change `build-auth-module` is what starts emitting them.

## Discovered during implementation

- **ESLint did not exist in this project.** No config, no dependency, no script — `AGENTS.md` and
  ticket 001 both imply it does. `eslint` and `typescript-eslint` were added as dev dependencies with
  a deliberately minimal flat config: the parser plus the clock rule, and nothing from
  `recommended`, so the lint run does exactly one job and does not churn existing code.
- **Flat-config `ignores` inside a config block removes the file from linting entirely**, rather than
  exempting it from that block's rules. Excluding `src/common/clock/**` that way left the directory
  with no configuration at all, so ESLint skipped it and the exemption test received no result. Fixed
  by linting all of `src/` and switching the rule off for the clock directory in a later block.
- **The lint rule bans `Date.now()` as well as `new Date()`.** Banning only the constructor leaves an
  equally silent way around the seam.
