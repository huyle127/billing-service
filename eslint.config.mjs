import tseslint from 'typescript-eslint';

const clockMessage =
  'Read the current time from the injected Clock in common/clock. Domain code that reads the system clock directly cannot be tested: a Stripe test clock moves Stripe time, not ours.';

const aliasMessage =
  'Import this through the @/ alias. A relative path climbing two or more levels does not say where it lands, and nest build rewrites @/ in the emitted JavaScript, so it costs nothing at runtime.';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: clockMessage },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: clockMessage,
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../../*'], message: aliasMessage }] },
      ],
    },
  },
  {
    files: ['src/common/clock/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../src/*'], message: aliasMessage }] },
      ],
    },
  },
);
