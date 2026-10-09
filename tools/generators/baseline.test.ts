import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { digest } from './files.ts';
import { baselineDifferences } from './baseline.ts';

it('distinguishes an unchanged generated baseline from feature edits and extra source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-baseline-'));
  try {
    const files = {
      'packages/example/package.json': JSON.stringify({
        name: '@scope/example',
        starter: { runtime: 'library' },
      }),
      'packages/example/src/index.ts': 'export const value=1;',
      'pnpm-lock.yaml': 'lock',
    };
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        managed: Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name !== 'pnpm-lock.yaml')
            .map(([name, text]) => [name, digest(text)]),
        ),
        lockId: digest('lock'),
      }),
    );
    expect(baselineDifferences(root)).toEqual([]);
    writeFileSync(path.join(root, 'packages/example/src/index.ts'), 'export const value=2;');
    writeFileSync(path.join(root, 'packages/example/src/extra.test.ts'), 'feature regression');
    expect(baselineDifferences(root)).toEqual([
      'packages/example/src/extra.test.ts',
      'packages/example/src/index.ts',
    ]);
    expect(readFileSync(path.join(root, 'packages/example/src/index.ts'), 'utf8')).toContain(
      'value=2',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
