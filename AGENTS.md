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