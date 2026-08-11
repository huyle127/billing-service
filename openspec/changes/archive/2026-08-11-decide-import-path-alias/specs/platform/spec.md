## ADDED Requirements

### Requirement: Distant imports go through the `@/` alias

A relative import that climbs two or more levels from a file under `src/`, and any import reaching
into `src/` from a file under `test/`, SHALL be written as `@/…`. A one-level relative import inside
`src/` stays relative. A lint rule MUST reject the relative forms.

`tsconfig.json` SHALL keep `"paths": { "@/*": ["./src/*"] }` and SHALL NOT gain a `baseUrl`.
`vitest.config.mts` SHALL carry a matching `resolve.alias`. The production build SHALL remain
`nest build`, which is what rewrites the alias into the emitted JavaScript.

#### Scenario: A distant relative import is rejected before it reaches review

- **WHEN** an import climbing two or more levels appears in a file under `src/`
- **THEN** the lint run fails and names the offending file

#### Scenario: A near relative import is left alone

- **WHEN** a file imports `./sibling` or `../dto/thing`, or imports a package by name
- **THEN** the lint run reports nothing for that line

#### Scenario: The alias resolves in the built output without a runtime resolver

- **WHEN** the service is built with `nest build` and started with `node dist/main`
- **THEN** every `@/` import resolves and the process boots
- **AND** no path-resolution package is installed or preloaded to make that happen

#### Scenario: The alias resolves under the test runner

- **WHEN** a spec file imports through `@/`
- **THEN** Vitest resolves it to the file under `src/`
