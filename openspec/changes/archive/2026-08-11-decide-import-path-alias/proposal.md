## Why

Ticket 035, `docs/wayfinder/tickets/035-decide-import-path-alias.md`. `tsconfig.json` has declared
`"paths": { "@/*": ["./src/*"] }` since the ticket-001 scaffold and no file uses it. That is worse
than either answer: a contributor who writes `@/common/clock/clock` compiles cleanly and then finds
`npm test` cannot resolve it. The ticket forbids leaving it half-configured; the answer is adopt.
Measurement overturned its cost estimate — `nest build` rewrites the alias, so no runtime resolver
and no new dependency is bought. Recorded in `design.md`.

## What Changes

- Adopt `@/` for two cases: under `src/`, any relative import climbing **two or more levels**; under
  `test/`, any import reaching into `src/`. One level inside `src/` stays relative.
- `vitest.config.mts` gains `resolve.alias`, without which every converted spec fails to import.
- `eslint.config.mjs` gains `no-restricted-imports`: `../../*` under `src/`, `../src/*` under
  `test/`. Both were verified to fire, and to stay silent on one-level and package imports.
- Convert 212 imports across 71 files under `src/`, and 150 across 12 files under `test/`.
- `docs/architecture/module-boundaries.md` states the convention; `tsconfig.json` is left exactly as
  it is — `paths` stays, `baseUrl` is not added.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `platform`: one new requirement — a distant import goes through `@/`, is rejected by lint when it
  does not, and resolves in both the built output and the test runner.

## Impact

No runtime behaviour, no schema, no configuration key, no dependency. Every module is touched, but
only its import lines. **Closes no requirement clause** — nothing in `requirement-coverage.md` moves
off `todo`, so this is the one change whose final task does not update that table.

**Test budget: 1.** A `no-restricted-imports` pattern that matches nothing passes silently and lets
the convention rot — the failure shape ticket 031 hit with a handler absent from its registry. The
vitest alias and the `nest build` rewrite both fail loudly when broken, so neither is tested.
