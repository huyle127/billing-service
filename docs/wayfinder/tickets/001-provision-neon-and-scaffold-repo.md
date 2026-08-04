# 001 Provision Neon and scaffold the repo

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: HITL (Neon account) then AFK -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Nothing to decide here — this is the manual work that unblocks every build and prototype ticket.
Done when a NestJS application boots locally, connects to Neon, and runs a trivial migration.

Human-in-the-loop portion:

- Create the Neon project and capture both connection strings: the pooled `DATABASE_URL` (with
  `pgbouncer=true`) and the `DIRECT_URL` used for migrations.
- Confirm where secrets live locally (`.env`, git-ignored).

Agent-driven portion:

- `git init` — the repository is not yet under version control.
- NestJS scaffold, TypeScript config, Prettier and ESLint per `AGENTS.md` (single quotes,
  Prettier defaults).
- Prisma wired to Neon. **`prisma/schema.prisma` and `prisma.config.ts` already exist** — written by
  tickets 007 and 008. Do not let `prisma init` overwrite either.
- **This is Prisma 7.** The `url` and `directUrl` datasource properties were removed from
  `schema.prisma`. Connection config now lives in `prisma.config.ts`, which is already pointed at
  `DIRECT_URL` because migrations must not run through PgBouncer. `directUrl` no longer exists as a
  property at all.
- **Unconfirmed and needed before the client works:** Prisma 7 requires a **driver adapter** passed
  to the `PrismaClient` constructor rather than reading a URL from the schema. Which adapter package
  to use for Neon over the pooled connection (`@prisma/adapter-pg` versus a Neon-specific adapter)
  was not verified — the documentation page for it did not load. Confirm this before writing client
  setup code; it determines the runtime connection path that ticket 006 spikes.
- Create `prisma/seed.ts` — `prisma.config.ts` already references it. Seeding the initial Free and
  Pro plans is required for registration to work at all.
- Run the initial migration with **`prisma migrate dev`**. Never `prisma db push`, not even for a
  local reset: it creates no migration file, so the constraints below could never be applied and
  the ledger's schema history would not exist.
- Append `prisma/sql/constraints.sql` to the generated initial migration — non-negative balance
  checks and the one-current-subscription partial unique index. Prisma cannot express these, and
  they are the invariants that survive concurrent access.
- Validate the schema (`prisma validate`) once Prisma is a real project dependency. It has not been
  parsed yet.
- Pre-commit hooks via `/setup-pre-commit`.

## Answer

Scaffolded and verified end to end on 2026-08-04. The application boots, connects to Neon through
the Prisma driver adapter, reads seeded data, and runs an interactive transaction.

**Versions:** Node 25.9.0 · Prisma 7.9.1 · TypeScript 6.0.3 · NestJS 11.

**The unconfirmed adapter question is settled: `@prisma/adapter-pg`.** `PrismaService` passes
`new PrismaPg({ connectionString: DATABASE_URL })` to the `PrismaClient` constructor. Confirmed
working by reading the seeded catalog and by running `prisma.$transaction` with a raw query inside
it — which also partially de-risks ticket 006, since interactive transactions demonstrably work over
the pooled Neon connection.

**Migrations:** two, both applied with `prisma migrate dev`, never `db push`.

- `..._init` — the full schema
- `..._add_ledger_constraints` — the hand-written SQL from `prisma/sql/constraints.sql`

**Constraints were verified by trying to violate them**, not by trusting the migration output. All
twelve checks behaved correctly, including the two that encode non-obvious decisions: a `PENDING`
subscription coexists with an `ACTIVE` one (the 3DS case from ticket 013), and two `NULL`
idempotency keys do not collide (the NULL-distinctness the ledger design relies on).

### Problems hit, and their fixes

- **`constraints.sql` referenced snake_case columns and would have failed entirely.** The schema maps
  table names but not column names, so Prisma generated quoted camelCase. Rewritten with quoted
  identifiers. Caught by checking the generated migration rather than assuming.
- **TypeScript 7.0 is incompatible with the Nest CLI.** TS 7.0 ships only the `tsc` executable and
  does not expose the programmatic compiler API the CLI needs; the API is expected back in 7.1.
  Pinned to `typescript@^6`.
- **TS 6 deprecates `baseUrl`**, and removing it requires path mappings to be relative (`./src/*`).
- **`tsconfig.build.json` with an explicit `rootDir`** was needed. Including `prisma/**/*.ts` in the
  root tsconfig pushed the common source directory up, emitting `dist/src/main.js` and silently
  breaking `main` and `start:prod`.

### Notes for later

- **npm 11 blocks install scripts** for `bcrypt`, `prisma`, `@prisma/engines`, and `esbuild`. All
  four were verified to work regardless, so no approval was granted. Revisit if a native module
  starts failing.
- **`pg` now warns that `sslmode=require` is treated as `verify-full`** and will adopt libpq
  semantics in `pg` v9. Harmless today; the connection strings will need
  `sslmode=verify-full` or `uselibpqcompat=true` before that major version.
- **Add-on package credit amounts are invented.** The Stripe catalog gives prices ($10, $40) but
  says nothing about how many credits each grants. `prisma/seed.ts` uses 100 and 500 as placeholders
  — these are product decisions and should be confirmed.
- `stripe listen` forwarding is still unverified; that remains on ticket 002 and can now be done,
  since an application exists to receive it.
