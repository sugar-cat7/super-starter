import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { acceptance } from './acceptance.ts';
import { globalChecks } from './definitions.ts';
import { projectOptions, verificationCases } from '../generators/options.ts';

it('rejects passed labels that omit applications or actual mechanism execution', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-fault-'));
  const sha = 'a'.repeat(40);
  try {
    for (const entry of verificationCases) {
      for (const os of entry.key === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux']) {
        const folder = path.join(root, `${entry.key}-${os}`);
        mkdirSync(folder);
        const report = {
          schema: 1,
          os: `${os}/x64`,
          sha: 'uncommitted',
          status: 'passed',
          contentId: 'forged',
          origin: { sha, dirty: false },
          configuration: projectOptions({
            name: 'fixture',
            scope: '@fixture',
            preset: entry.preset,
            features: entry.features,
          }),
          workspace: [],
          tools: {},
          checks: globalChecks.map((check) => ({ ...check, status: 'passed', milliseconds: 1 })),
        };
        writeFileSync(path.join(folder, `gate-full-all-${os}.json`), JSON.stringify(report));
        writeFileSync(
          path.join(folder, 'generation.json'),
          JSON.stringify({ ...report, baselineDifferences: [] }),
        );
      }
    }
    for (const file of [
      'faults',
      'hooks',
      'lifecycle',
      'sanitization',
      'agent-web-api',
      'agent-desktop',
      'agent-package-add',
    ])
      writeFileSync(
        path.join(root, `${file}.json`),
        JSON.stringify({
          schema: 1,
          sha,
          status: 'passed',
          contentId: 'forged',
          commands: [
            {
              command: 'echo gate:pre-pr gate:full build deploy:preflight git commit git push',
              status: 'passed',
            },
          ],
        }),
      );
    const result = acceptance(root, sha);
    expect(result.status).toBe('blocked');
    expect(result.rows.every((row) => row.status === 'blocked')).toBe(true);
    expect(result.mechanisms.every((entry) => entry.status === 'blocked')).toBe(true);
    expect(acceptance(root, 'b'.repeat(40)).status).toBe('blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires actual executables and subcommands rather than mention-only or help commands', async () => {
  const { agentCommandValid } = await import('./acceptance.ts');
  expect(agentCommandValid('full', ['echo', 'pnpm', 'gate:full'])).toBe(false);
  expect(agentCommandValid('commit', ['git', 'commit', '--help'])).toBe(false);
  expect(agentCommandValid('push', ['git', 'push', '--no-verify'])).toBe(false);
  expect(agentCommandValid('commit', ['git', 'commit', '-an', '-m', 'Feature'])).toBe(false);
  expect(agentCommandValid('push', ['git', 'push', '-n', 'origin', 'HEAD'])).toBe(false);
  expect(agentCommandValid('full', ['pnpm', 'gate:full', '--', '--checks', 'javascript'])).toBe(
    false,
  );
  expect(agentCommandValid('commit', ['git', '-c', 'core.hooksPath=/tmp', 'commit'])).toBe(false);
  expect(agentCommandValid('preflight', ['pnpm', 'deploy:preflight', '--dry-run'])).toBe(false);
  expect(
    agentCommandValid('full', ['mise', 'exec', 'pnpm@12.10.1', '--', 'pnpm', 'gate:full']),
  ).toBe(true);
  expect(
    agentCommandValid('targeted-test', ['pnpm', '--filter', '@fixture/api', 'test:unit']),
  ).toBe(true);
  expect(agentCommandValid('commit', ['git', '-C', '/project', 'commit', '-m', 'Feature'])).toBe(
    true,
  );
});
