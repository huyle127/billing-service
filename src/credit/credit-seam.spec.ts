import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = ['billing', 'user', 'auth'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the credit seam', () => {
  it('keeps credit a leaf that imports no feature module', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src', 'credit'))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) =>
        FORBIDDEN.some((module) =>
          new RegExp(`from '(\\.\\./)+${module}/`).test(source),
        ),
      );

    expect(offenders.map(({ file }) => relative(process.cwd(), file))).toEqual([]);
  });
});
