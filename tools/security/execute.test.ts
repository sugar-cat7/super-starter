import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute } from './scan.ts';

it('retains scanner exit status and strips the remediation credential from subprocesses', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'security-process-'));
  const log = path.join(root, 'process.log');
  try {
    const code = await execute(
      process.execPath,
      [
        '-e',
        'console.log(process.env.SECURITY_REMEDIATION_TOKEN ?? "absent"); process.exitCode=1;',
      ],
      root,
      log,
      10_000,
      { ...process.env, SECURITY_REMEDIATION_TOKEN: 'approved-fixture-credential' },
    );
    expect(code).toBe(1);
    expect(readFileSync(log, 'utf8').trim()).toBe('absent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails a hung real scanner process and rejects executable startup errors', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'security-timeout-'));
  try {
    await expect(
      execute(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000);'],
        root,
        path.join(root, 'timeout.log'),
        500,
      ),
    ).rejects.toThrow('Scanner terminated or timed out');
    const missing = execute(
      'nonexistent-security-scanner-fixture',
      [],
      root,
      path.join(root, 'missing.log'),
      10_000,
    );
    // Windows starts the Job host successfully, then reports executable failure
    // as a child exit code. Unix reports spawn ENOENT before a child exists.
    const failure = await missing.then(
      (code) => ({ kind: 'exit', failed: code !== 0 }),
      (error: NodeJS.ErrnoException) => ({ kind: 'spawn', code: error.code }),
    );
    expect(failure).toEqual(
      process.platform === 'win32'
        ? { kind: 'exit', failed: true }
        : { kind: 'spawn', code: 'ENOENT' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
