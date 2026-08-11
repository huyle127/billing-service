## Context

Ticket 035 asked whether this service imports relatively or through `@/`, and named three places the
alias has to work: `tsconfig.json`, the built output, and Vitest. It required each to be measured
rather than assumed. They were, and one measurement came back the opposite of what the ticket
predicted, which is why this change has a design file at all.

## Goals / Non-Goals

**Goals:** settle the convention, bind it in the three configuration files, convert the existing
imports, and record what keeps the alias alive at runtime.

**Non-Goals:** no runtime dependency, no `baseUrl`, no change to `tsconfig.json`, no reorganisation
of any directory. Import lines only.

## Decisions

**The alias reaches runtime because of the Nest CLI, not TypeScript — and ticket 035 has this
backwards.** The ticket states that neither `tsc` nor `nest build` rewrites path aliases and that a
built `dist/main.js` would die at boot. Half of that is right. Measured on this repo: `nest build`
emits `require("./billing/stripe/stripe.constants")` and the built file runs, because the Nest CLI
applies a tsconfig-paths transformer during compilation; plain `npx tsc -p tsconfig.build.json`
emits `require("@/billing/stripe/stripe.constants")`, which would fail. So the alias costs nothing —
no `tsc-alias`, no `module-alias`, no `-r tsconfig-paths/register` on `start:prod`. The bill is a
constraint instead of a dependency: **`npm run build` must stay `nest build`.** That sentence is the
main thing this change writes into `module-boundaries.md`, because the failure it prevents is a
process that will not boot and a `package.json` edit that looks harmless.

**`baseUrl` is not needed.** `paths` with a `./src/*` target resolves relative to the `tsconfig.json`
directory under TypeScript 6.0.3; `npx tsc -p tsconfig.build.json --noEmit` over a file importing
`@/billing/stripe/stripe.constants` exits 0. The ticket flagged this as unconfirmed; it is now
confirmed, and `tsconfig.json` needs no edit at all.

**The convention is "two levels", not "cross-module", because the enforcing tool decides what a rule
can mean.** `no-restricted-imports` matches the import *string* and cannot resolve a path, so it
cannot separate `billing/webhook/handlers → ../../stripe/stripe.constants` (inside `billing`) from
`billing/services → ../../common/clock/clock` (across modules). Fifty-seven imports sit in that gap.
The alternatives were to exempt `src/billing/**`, which switches the rule off in the module holding
most of the imports, or to enforce by a source-scanning test as `stripe-seam.spec.ts` does, which
resolves paths but gives no feedback in an editor. Moving the convention to what the string already
shows keeps one mechanism and one meaning. It also serves the ticket's own argument better:
`../../stripe/types/stripe.types` is exactly as direction-blind as `../../../credit/services`, and
the ticket's complaint was about direction, not about module membership.

**Two patterns, one per root, because the roots differ.** Under `src/` the rule is `../../*`. Under
`test/` every reach into the source tree is a single level — `../src/…` — so the same pattern would
never fire there; the rule is `../src/*`. Both were verified against the ESLint API before being
written down: each fires on its target and stays silent on `./x`, `../dto/x`, and package imports.

**One level inside `src/` stays relative.** `../dto/create.dto` names its target unambiguously.
Converting it would churn every sibling import in the repo and buy no legibility.

## Risks / Trade-offs

**A future contributor switches `build` to plain `tsc` and the service stops booting.** → Stated in
`module-boundaries.md` next to the convention. Not tested: the failure is a module-not-found at
startup, which is loud, and a test that shells out to a full build to prove it would cost more than
the trap it guards.

**The lint pattern silently matches nothing and the convention rots.** → This is the one thing here
that can fail without a signal, so it is the change's single test: assert the repo's own ESLint
configuration reports an error for a two-level relative import and none for a one-level one.

**`test/` is outside `tsconfig.json`'s `include`.** → `@/` in a test file is resolved by Vitest, not
by `tsc`, so a typo there surfaces as a failing import at test time rather than a type error. Adding
`test/**/*.ts` to `include` would start typechecking the suite, which is a different change with a
different risk; left alone deliberately.

**A large diff across 83 files makes the next `git blame` noisier.** → Accepted. The ticket's own
argument is that this only gets more expensive: it was twelve files when written and is eighty-three
now.
