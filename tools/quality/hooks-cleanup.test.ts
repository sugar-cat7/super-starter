import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runSync } from '../process.ts';
import { removeOwnedWorktree } from './hooks.ts';

function fixture() {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-cleanup-'));
  const root = path.join(owned, 'repository');
  const snapshot = path.join(owned, 'snapshot');
  try {
    mkdirSync(root);
    const git = (args: string[]) => runSync('git', args, root);
    git(['init', '-q']);
    git(['config', '--local', 'user.name', 'Cleanup regression']);
    git(['config', '--local', 'user.email', 'cleanup@example.invalid']);
    git(['config', '--local', 'core.longpaths', 'false']);
    writeFileSync(path.join(root, 'tracked.txt'), 'tracked input');
    git(['add', 'tracked.txt']);
    git(['commit', '-qm', 'Initial input']);
    const originalWorktrees = git(['worktree', 'list', '--porcelain']);
    git(['worktree', 'add', '--detach', snapshot, 'HEAD']);
    return { owned, root, snapshot, git, originalWorktrees };
  } catch (error) {
    rmSync(owned, { recursive: true, force: true });
    throw error;
  }
}

describe('owned hook worktree cleanup', () => {
  it('removes deep dependency paths without changing Git config or following an outside junction', () => {
    const { owned, root, snapshot, git, originalWorktrees } = fixture();
    try {
      const deep = path.join(
        snapshot,
        'node_modules',
        '.pnpm',
        ...Array.from({ length: 6 }, (_, i) => `${i}-${'resolved-package-'.repeat(5)}`),
        'file.txt',
      );
      expect(deep.length).toBeGreaterThan(320);
      mkdirSync(path.dirname(deep), { recursive: true });
      writeFileSync(deep, 'owned dependency bytes');
      const outside = path.join(owned, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve sibling');
      symlinkSync(outside, path.join(snapshot, 'outside-link'), 'junction');
      removeOwnedWorktree(root, snapshot);
      expect(existsSync(snapshot)).toBe(false);
      expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserve sibling');
      expect(git(['config', '--local', '--get', 'core.longpaths'])).toBe('false');
      expect(git(['worktree', 'list', '--porcelain'])).toBe(originalWorktrees);
      expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('tracked input');
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it('propagates a refused cleanup and removes only the owned worktree after unlocking', () => {
    const { owned, root, snapshot, git } = fixture();
    try {
      git(['worktree', 'lock', '--reason', 'Preserve locked fixture', snapshot]);
      expect(() => removeOwnedWorktree(root, snapshot)).toThrow(/locked/u);
      expect(existsSync(snapshot)).toBe(true);
      expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('tracked input');
      git(['worktree', 'unlock', snapshot]);
      removeOwnedWorktree(root, snapshot);
      expect(existsSync(snapshot)).toBe(false);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });
});
