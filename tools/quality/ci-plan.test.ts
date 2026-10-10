import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ciPlan } from './ci-plan.ts';

it('plans runtime checks on the changed real application, skips unrelated native work, and restores all checks for infrastructure changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-ci-plan-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI planning test');
    git('config', 'user.email', 'test@example.invalid');
    for (const [name, runtime, dependencies] of [
      ['api', 'worker', {}],
      ['web', 'worker', { '@test/api': 'workspace:*' }],
      ['desktop', 'desktop', {}],
    ] as const) {
      mkdirSync(path.join(root, 'packages', name), { recursive: true });
      writeFileSync(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({
          name: `@test/${name}`,
          starter: { runtime },
          dependencies,
          scripts: { test: 'test', build: 'build', 'test:runtime': 'runtime' },
        }),
      );
    }
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'packages/api/source.ts'), 'broken implementation');
    git('add', '.');
    git('commit', '-qm', 'API change');
    const api = ciPlan(root, base);
    expect(api.selected).toEqual(['@test/api', '@test/web']);
    expect(api.checks).toContain('@test/api/runtime');
    expect(api.native).toBe(false);
    expect(api.fixtures).toBe(false);
    writeFileSync(path.join(root, 'mise.toml'), 'changed infrastructure');
    git('add', '.');
    git('commit', '-qm', 'root change');
    const all = ciPlan(root, base);
    expect(all.nativeMatrix.include).toHaveLength(3);
    expect(all.fixtures).toBe(true);
    expect(all.checks).toContain('@test/desktop/native');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
