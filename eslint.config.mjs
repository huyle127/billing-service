import tseslint from 'typescript-eslint';

const clockMessage =
  'Read the current time from the injected Clock in common/clock. Domain code that reads the system clock directly cannot be tested: a Stripe test clock moves Stripe time, not ours.';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: clockMessage },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: clockMessage,
        },
      ],
    },
  },
  {
    files: ['src/common/clock/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
