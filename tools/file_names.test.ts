// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Google TypeScript style guide: file names are snake_case, never camelCase or PascalCase (#75). Hyphens are left
// alone (the e2e specs, Vite's `vite-env.d.ts`).
describe('file names', () => {
  it('no tracked .ts file has a capital letter in its name', () => {
    const files = execFileSync('git', ['ls-files', '*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(files.filter((f) => /[A-Z]/.test(f.split('/').at(-1) ?? f))).toEqual([]);
  });
});
