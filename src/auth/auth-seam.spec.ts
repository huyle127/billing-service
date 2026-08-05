import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the auth seam', () => {
  it('keeps credential storage inside the auth module', () => {
    const authDirectory = join('src', 'auth');
    const offenders = sourceFiles(join(process.cwd(), 'src'))
      .filter((file) => !relative(process.cwd(), file).startsWith(authDirectory))
      .filter((file) => /authCredential/i.test(readFileSync(file, 'utf8')));

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});
