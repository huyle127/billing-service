# 035 Decide whether imports use the `@/` path alias

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-11) -->
<!-- assignee: -->
<!-- output: tsconfig.json, vitest.config.ts, docs/architecture/module-boundaries.md -->
<!-- blocked-by: -->

## Question

Does this service import by relative path or through the `@/` alias, and if the alias, what has to
change for it to work at runtime as well as at compile time?

`tsconfig.json` **already declares** `"paths": { "@/*": ["./src/*"] }` — added by the scaffold in
ticket 001 — and **nothing uses it**. Every import today is relative:
`../../common/clock/clock`, `../../common/errors/domain.exception`. So the repo currently carries a
half-configured feature, which is worse than either answer: a later contributor reads the tsconfig,
writes `@/common/clock/clock`, and it compiles.

**Why it is worth deciding now rather than later.** Only `common/` and `billing/stripe/` exist. Every
remaining build ticket adds imports, and a cross-module import is exactly where a relative path gets
long enough to be misread — `../../../credit/services/wallet.service` says nothing about direction,
while `@/credit/services/wallet.service` does. Converting fifty files later is churn; converting
twelve now is not.

**What it costs, and this is the part that must be checked rather than assumed.** The alias is three
places, not one:

- `tsconfig.json` — `paths` is declared; whether it also needs `baseUrl` under TS 6 must be
  confirmed, not guessed.
- **Runtime.** `tsc` and `nest build` do **not** rewrite path aliases in emitted JavaScript. A built
  `dist/main.js` containing `require('@/common/...')` fails at boot with a module-not-found. Either
  a resolver runs in production, or the build rewrites, or the alias stays a compile-time fiction
  that breaks the moment `npm run start:prod` is used. **Verify by running the built output, not by
  running `nest start`** — the dev path can succeed where the built one fails.
- `vitest.config.ts` — needs a matching `resolve.alias`, or every spec file fails to import.

A reference implementation exists: `nghiahoangDigiEx/AI-billing-service` uses `@/` throughout. What
it does about the runtime resolution is the thing to read there, not the fact that it uses the alias.

**Answer either way, then bind it.** If the alias is adopted, `module-boundaries.md` states it and
the relative imports in `common/` and `billing/stripe/` are converted in the same change. If it is
rejected, **remove `paths` from `tsconfig.json`** so the trap is gone. Leaving it as it is now is the
one outcome that is not allowed.

Closes no requirement clause. Touches no schema, no configuration key, no runtime dependency.

## Answer

**Adopted**, through OpenSpec change `decide-import-path-alias`. 362 imports across 83 files
converted; `npm run lint` clean, `tsc --noEmit` clean, 215 tests passing, and `node dist/main`
booted.

**The section above headed "what must be checked rather than assumed" got its own answer wrong, in
the safe direction.** It asserted that neither `tsc` nor `nest build` rewrites path aliases and that
a built `dist/main.js` would fail at boot. Measured on this repo:

| | Emits | Runs |
| --- | --- | --- |
| `nest build` | `require("./billing/stripe/stripe.constants")` | yes |
| `npx tsc -p tsconfig.build.json` | `require("@/billing/stripe/stripe.constants")` | no |

The Nest CLI applies a tsconfig-paths transformer during compilation. So the alias buys **no runtime
resolver and no dependency** — `tsc-alias`, `module-alias` and `-r tsconfig-paths/register` are all
absent. What it buys instead is a constraint: **`npm run build` must stay `nest build`**, recorded in
[`module-boundaries.md`](../../architecture/module-boundaries.md) beside the convention. `baseUrl`
was the other open question and is **not needed** — `paths` with a `./src/*` target resolves against
the tsconfig directory under TS 6.0.3, so `tsconfig.json` was not edited at all. Vitest was the one
place the ticket called correctly: without `resolve.alias` every spec fails with
`Cannot find package '@/…'`.

**The rule is "two or more levels", not "cross-module", because the enforcing tool decides what a
rule can mean.** `no-restricted-imports` matches the import *string* and cannot resolve a path, so it
cannot separate `billing/webhook/handlers → ../../stripe/…` (inside `billing`) from
`billing/services → ../../common/…` (across modules); 57 imports sat in that gap. The alternatives
were to exempt `src/billing/**` — switching the rule off in the module holding most of the imports —
or to enforce with a source-scanning test like `stripe-seam.spec.ts`, which resolves paths but says
nothing in an editor. Two patterns bind it: `../../*` under `src/`, `../src/*` under `test/`, since
a test file reaches the source tree in a single level and the first pattern would never fire there.

One test, `test/import-convention.spec.ts`, and it exists for a specific reason: **a
`no-restricted-imports` pattern that matches nothing passes silently** and the convention rots with
nothing reporting a problem. Verified by mutation — repointing the pattern at a group that matches
nothing turns the assertion red.

**Known limit, since closed.** `test/` was outside `tsconfig.json`'s `include`, so `@/` in a spec was
resolved by Vitest and never by `tsc`. This was left alone at first as a different change with a
different risk; measuring it later showed the risk was one line. `test/**/*.ts` joined `include` on
2026-08-11 and the whole suite typechecks, at the cost of a single genuine finding —
`addon-purchase.spec.ts` caught a rejection with `.catch(error => error as DomainException)`, giving
`thrown` the type `DomainException | PurchaseView`, so `thrown.code` was never checked against
anything. Rewritten as `rejects.toMatchObject({ code: 'WALLET_FROZEN' })`, which also fails if the
call resolves. `tsconfig.build.json` overrides `include` with `src/**/*`, so the build is unaffected.
