import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runSync } from '../process.ts';
import { assertCheckout } from './checkout.ts';

it('rejects preparation edits and first-party untracked files against the requested commit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'checkout-input-'));
  const git = (args: string[]) => runSync('git', args, root);
  try {
    git(['init', '-q']);
    writeFileSync(path.join(root, 'input.txt'), 'committed');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'input',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    assertCheckout(root, sha);
    writeFileSync(path.join(root, 'input.txt'), 'autofixed by setup');
    expect(() => assertCheckout(root, sha)).toThrow(
      /Preparation changed the committed input.*input.txt/su,
    );
    git(['checkout', '--', 'input.txt']);
    writeFileSync(path.join(root, 'unexpected.ts'), 'new generated source');
    expect(() => assertCheckout(root, sha)).toThrow(/unexpected.ts/u);
    expect(() => assertCheckout(root, '0'.repeat(40))).toThrow(/Checkout HEAD changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
