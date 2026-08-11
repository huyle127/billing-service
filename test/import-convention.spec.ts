import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const PROBE = 'src/billing/services/probe.service.ts';

async function rulesFiredOn(source: string, filePath: string): Promise<string[]> {
  const [result] = await new ESLint().lintText(source, { filePath });

  return result.messages.map((message) => message.ruleId ?? '');
}

describe('the import convention', () => {
  it('rejects a distant relative import and leaves a near one alone', async () => {
    const distant = await rulesFiredOn(
      "import { Clock } from '../../common/clock/clock';\n",
      PROBE,
    );
    const near = await rulesFiredOn("import { Thing } from '../dto/thing.dto';\n", PROBE);
    const fromTest = await rulesFiredOn(
      "import { AppModule } from '../src/app.module';\n",
      'test/probe.spec.ts',
    );

    expect(distant).toContain('no-restricted-imports');
    expect(fromTest).toContain('no-restricted-imports');
    expect(near).not.toContain('no-restricted-imports');
  });
});
