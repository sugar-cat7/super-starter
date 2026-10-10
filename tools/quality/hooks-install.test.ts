import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runSync } from '../process.ts';
import { installHooks } from './hooks.ts';

it('refuses a nested project without writing the parent Git configuration or user files', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'starter-parent-hooks-'));
  const project = path.join(parent, 'artifacts', 'project');
  try {
    runSync('git', ['init', '--quiet'], parent);
    mkdirSync(path.join(project, 'tools/quality/git-hooks'), { recursive: true });
    writeFileSync(path.join(parent, '.gitignore'), 'artifacts/\n');
    writeFileSync(path.join(parent, 'user.txt'), 'Existing user content');
    for (const event of ['pre-commit', 'pre-push'])
      writeFileSync(path.join(project, 'tools/quality/git-hooks', event), '#!/bin/sh\nexit 0\n');
    const configuration = readFileSync(path.join(parent, '.git/config'));
    expect(() => installHooks(project)).toThrow(/Nested project.*git init/u);
    expect(readFileSync(path.join(parent, '.git/config'))).toEqual(configuration);
    expect(readFileSync(path.join(parent, 'user.txt'), 'utf8')).toBe('Existing user content');
    for (const event of ['pre-commit', 'pre-push'])
      expect(readFileSync(path.join(project, 'tools/quality/git-hooks', event), 'utf8')).toBe(
        '#!/bin/sh\nexit 0\n',
      );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
