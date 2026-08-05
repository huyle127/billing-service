import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(filePath: string, source: string): Promise<ESLint.LintResult> {
  const [result] = await eslint.lintText(source, { filePath, warnIgnored: false });
  return result;
}

describe('the clock lint rule', () => {
  it('rejects a direct system clock read in domain code', async () => {
    const result = await lint('src/billing/planted.ts', 'export const at = new Date();\n');

    expect(result.errorCount).toBe(1);
    expect(result.messages[0].message).toContain('injected Clock');
  });

  it('rejects Date.now(), which would otherwise walk around the rule', async () => {
    const result = await lint('src/billing/planted.ts', 'export const at = Date.now();\n');

    expect(result.errorCount).toBe(1);
  });

  it('allows the clock implementation itself', async () => {
    const result = await lint('src/common/clock/planted.ts', 'export const at = new Date();\n');

    expect(result.errorCount).toBe(0);
  });
});
