import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { structure } from './structure.ts';

function fixture(files: Record<string, string>, inspect: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'boundary-'));
  try {
    for (const [filename, text] of Object.entries({
      'packages/web/package.json': JSON.stringify({
        name: '@example/web',
        starter: { runtime: 'worker' },
      }),
      'packages/api/package.json': JSON.stringify({
        name: '@example/api',
        starter: { runtime: 'worker' },
      }),
      'packages/contracts/package.json': JSON.stringify({ name: '@example/contracts' }),
      ...files,
    })) {
      mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      writeFileSync(path.join(root, filename), text);
    }
    inspect(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('runtime boundaries', () => {
  it('detects a server import reached indirectly by a route while allowing a Worker-only helper', () => {
    fixture(
      {
        'packages/web/src/routes/index.ts': "import '../helpers/read.ts';",
        'packages/web/src/helpers/read.ts': "import 'fs/promises';",
        'packages/web/src/server.ts': "import 'node:crypto';",
      },
      (root) => {
        const errors = structure(root);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('client dependency boundary violation: fs/promises');
        expect(errors[0]).toContain('routes/index.ts');
      },
    );
  });
  it('rejects application implementation imports and platform APIs in shared contracts', () => {
    fixture(
      {
        'packages/web/src/server.ts': "export * from '../../api/src/index.ts';",
        'packages/contracts/src/index.ts': "export * from '@tauri-apps/api/core';",
      },
      (root) => {
        expect(structure(root)).toEqual(
          expect.arrayContaining([
            expect.stringContaining('application implementation import is forbidden'),
            expect.stringContaining('runtime boundary violation'),
          ]),
        );
      },
    );
  });
  it('examines dynamic imports and passes portable shared code', () => {
    fixture(
      { 'packages/contracts/src/index.ts': "export const load = () => import('node:fs');" },
      (root) =>
        expect(structure(root)).toEqual([expect.stringContaining('runtime boundary violation')]),
    );
    fixture(
      {
        'packages/contracts/src/index.ts':
          'export const normalize = (text: string) => text.trim();',
      },
      (root) => expect(structure(root)).toEqual([]),
    );
  });
});
