# 035 Decide whether imports use the `@/` path alias

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
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
