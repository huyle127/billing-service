# AI Rules

## Language

- Explain in Vietnamese.
- Write all code in English.
- Use TypeScript.
- Use Prisma ORM.

## Code Style

- Do not write comments unless explicitly requested.
- Prefer early return.
- Prefer ternary operator over simple if/else.
- Avoid nested if/else.
- Keep functions small and focused.
- Reuse existing code before creating new abstractions.
- Do not refactor unrelated code.

## Formatting

- Add a space after commas.
- Follow Prettier defaults.
- Use single quotes unless the project uses double quotes.

## Architecture

- Keep business logic out of controllers.
- Stripe is an infrastructure adapter.
- Use transactions for state-changing operations.

## Scope

- Build only what has a caller in the current change.
- Test only what can break silently: database constraints, concurrency, money, idempotency,
  transaction rollback. Not field mapping, DI wiring, or log text.
- At most 10 new tests per change — see `docs/testing/strategy.md`.
- Ask about ambiguous business rules before building, not after.
- Say a thing once, in the place that owns it, and link to it from elsewhere. This applies to
  documents as much as to code.