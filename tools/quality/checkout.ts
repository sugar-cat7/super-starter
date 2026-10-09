import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runSync } from '../process.ts';

export function assertCheckout(root: string, expected: string): void {
  const head = runSync('git', ['rev-parse', 'HEAD'], root);
  if (head !== expected)
    throw new Error(`Checkout HEAD changed: expected ${expected}, got ${head}`);
  const difference = spawnSync('git', ['diff', '--name-only', expected, '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (difference.status !== 0) throw new Error('Unable to inspect checkout changes');
  const untracked = runSync('git', ['ls-files', '--others', '--exclude-standard'], root);
  const names = [difference.stdout.trim(), untracked].filter(Boolean).join('\n');
  if (names) throw new Error(`Preparation changed the committed input:\n${names}`);
  console.log(`Verified immutable checkout ${head}`);
}

if (process.argv[1]?.endsWith(`${path.sep}checkout.ts`)) {
  const expected = process.env.CI_HEAD_SHA ?? process.argv[2];
  if (!expected) throw new Error('Provide the expected checkout SHA');
  assertCheckout(process.cwd(), expected);
}
