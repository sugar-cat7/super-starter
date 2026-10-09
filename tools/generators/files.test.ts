import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyFiles, recover, digest } from './files.ts';
import { safeFile } from './safety.ts';

describe('generation transaction', () => {
  it('rolls back every earlier write and preserves unrelated user changes after an I/O failure', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-rollback-'));
    try {
      writeFileSync(path.join(root, 'existing.json'), 'original');
      writeFileSync(path.join(root, 'user.txt'), 'user changes');
      expect(() =>
        applyFiles(
          root,
          new Map([
            ['existing.json', Buffer.from('replacement')],
            ['new/file.ts', Buffer.from('new')],
          ]),
          [],
          (index) => {
            if (index === 1) throw new Error('simulated disk failure');
          },
        ),
      ).toThrow('simulated disk failure');
      expect(readFileSync(path.join(root, 'existing.json'), 'utf8')).toBe('original');
      expect(readFileSync(path.join(root, 'user.txt'), 'utf8')).toBe('user changes');
      expect(existsSync(path.join(root, 'new'))).toBe(false);
      applyFiles(root, new Map([['new/file.ts', Buffer.from('repaired')]]));
      expect(readFileSync(path.join(root, 'new/file.ts'), 'utf8')).toBe('repaired');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('recovers an interrupted transaction without reading an external path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-recover-'));
    try {
      writeFileSync(path.join(root, 'file.txt'), 'partial write');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: [
            {
              path: 'file.txt',
              previous: Buffer.from('before').toString('base64'),
              next: digest('partial write'),
            },
          ],
          directories: [],
        }),
      );
      recover(root);
      expect(readFileSync(path.join(root, 'file.txt'), 'utf8')).toBe('before');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: [{ path: '../outside', previous: null }],
          directories: [],
        }),
      );
      expect(() => recover(root)).toThrow('Unsafe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses recovery before any rollback when a user has edited a partially written file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-concurrent-'));
    try {
      writeFileSync(path.join(root, 'first.txt'), 'generated');
      writeFileSync(path.join(root, 'second.txt'), 'user edit after crash');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: ['first.txt', 'second.txt'].map((filename) => ({
            path: filename,
            previous: Buffer.from('before').toString('base64'),
            next: digest('generated'),
          })),
          directories: [],
        }),
      );
      expect(() => recover(root)).toThrow('Recovery found a user change');
      expect(readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('generated');
      expect(readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe('user edit after crash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects Windows alternate streams and dangling symlink traversal on every platform', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-paths-'));
    try {
      for (const filename of ['file:stream', 'CON.txt', 'dir/../file', 'file.'])
        expect(() => safeFile(root, filename)).toThrow('Unsafe relative path');
      symlinkSync(path.join(root, 'missing'), path.join(root, 'link'), 'junction');
      expect(() => safeFile(root, 'link/file')).toThrow('Refusing symlink traversal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
