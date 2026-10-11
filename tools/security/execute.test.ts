import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute, expectedSources } from './scan.ts';

it('scans source directories named gen/target while excluding only owned build paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'security-coverage-'));
  try {
    const files = {
      'packages/web/package.json': '{"name":"web","starter":{"runtime":"worker"}}',
      'packages/web/src/gen/a.ts': 'export const x = 1;',
      'packages/web/dist/a.ts': 'generated',
      'packages/target/package.json': '{"name":"target"}',
      'packages/target/src/a.ts': 'export const y = 2;',
      'tools/config.json': '{}',
      '.github/workflows/test.yml': 'name: test',
    };
    for (const [filename, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      writeFileSync(path.join(root, filename), contents);
    }
    expect(expectedSources(root)).toEqual([
      '.github/workflows/test.yml',
      'packages/target/package.json',
      'packages/target/src/a.ts',
      'packages/web/package.json',
      'packages/web/src/gen/a.ts',
      'tools/config.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('retains scanner exit status and strips the remediation credential from subprocesses', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'security-process-'));
  const log = path.join(root, 'process.log');
  try {
    const code = await execute(
      process.execPath,
      [
        '-e',
        'console.log([process.env.SECURITY_REMEDIATION_TOKEN,process.env.TRIVY_SEVERITY,process.env.SEMGREP_APP_TOKEN].map(x=>x??"absent").join(" ")); process.exitCode=1;',
      ],
      root,
      log,
      10_000,
      {
        ...process.env,
        SECURITY_REMEDIATION_TOKEN: 'approved-fixture-credential',
        TRIVY_SEVERITY: 'LOW',
        SEMGREP_APP_TOKEN: 'fixture-token',
      },
    );
    expect(code).toBe(1);
    expect(readFileSync(log, 'utf8').trim()).toBe('absent absent absent');
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
