## 1. Bind the alias in configuration

- [x] 1.1 Add `resolve.alias` mapping `@` to `./src/` in `vitest.config.mts`.
- [x] 1.2 Add `no-restricted-imports` to `eslint.config.mjs` — pattern `../../*` for `src/**/*.ts` and `../src/*` for `test/**/*.ts`, each with a message naming the alias.
- [x] 1.3 Add `test/import-convention.spec.ts` asserting the repo's own ESLint config reports an error for a two-level relative import and reports nothing for a one-level one.

## 2. Convert the imports

- [x] 2.1 Convert the 212 imports climbing two or more levels across 71 files under `src/` to `@/`.
- [x] 2.2 Convert the 150 imports reaching into `src/` across 12 files under `test/` to `@/`.
- [x] 2.3 Run `npm run lint` and `npm test`, and confirm the lint run is clean and 215 tests pass.

## 3. Verify runtime and record the decision

- [x] 3.1 Run `npm run build`, confirm no `require("@/` remains anywhere in `dist/`, and start `node dist/main` to confirm the service boots with no path-resolution package installed.
- [x] 3.2 State the convention and the `npm run build` must stay `nest build` constraint in `docs/architecture/module-boundaries.md`.
- [x] 3.3 Close `docs/wayfinder/tickets/035-decide-import-path-alias.md` with the answer and add its decision line to `docs/wayfinder/map-billing-service-build.md`; no row in `docs/testing/requirement-coverage.md` moves, because this change closes no clause.
