import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pnpmCommand, pnpm } from '../process.ts';
import { workspacePackages } from './graph.ts';

async function capture(
  root: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  const invocation = pnpmCommand(args);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: root,
      env: { ...process.env, STARTER_CHECK_PHASE: 'quality' },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Fault command timed out: ${args.join(' ')}`));
    }, 180_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export async function faultRehearsal(root: string): Promise<void> {
  await pnpm(['check'], { cwd: root });
  const probe = path.join(root, 'tools/fault-probe.ts');
  const cases: { id: string; contents: string; command: string[]; reason: RegExp }[] = [
    {
      id: 'format',
      contents: 'export const formatFault="needs formatting"\n',
      command: ['exec', 'vp', 'fmt', '--check', 'tools/fault-probe.ts'],
      reason: /formatting issues/u,
    },
    {
      id: 'lint',
      contents: 'debugger;\n',
      command: ['exec', 'vp', 'lint', 'tools/fault-probe.ts'],
      reason: /no-debugger/u,
    },
    {
      id: 'type',
      contents: "export const typeFault: number = 'wrong';\n",
      command: ['exec', 'vp', 'check'],
      reason: /TS2322/u,
    },
    {
      id: 'unit',
      contents:
        "import { it, expect } from 'vitest';\nit('injected fault', () => { expect(1).toBe(2); });\n",
      command: ['exec', 'vp', 'test', 'run', 'tools/fault-probe.test.ts'],
      reason: /expected 1 to be 2/u,
    },
    {
      id: 'no-tests',
      contents: 'export const collectedCases = 0;\n',
      command: ['exec', 'vp', 'test', 'run', 'tools/fault-probe.test.ts'],
      reason: /No test|No tests|No test suite/u,
    },
    {
      id: 'timeout',
      contents:
        "import { it } from 'vitest';\nit('injected timeout', async () => { await new Promise<void>(() => {}); }, 20);\n",
      command: ['exec', 'vp', 'test', 'run', 'tools/fault-probe.test.ts'],
      reason: /timed out|Timeout/u,
    },
  ];
  const reports = [];
  for (const fault of cases) {
    const filename = fault.command.includes('tools/fault-probe.test.ts')
      ? path.join(root, 'tools/fault-probe.test.ts')
      : probe;
    writeFileSync(filename, fault.contents);
    const result = await capture(root, fault.command);
    assert.notEqual(result.code, 0, `${fault.id} must fail`);
    assert.match(result.output, fault.reason);
    rmSync(filename);
    await pnpm(
      fault.id === 'unit' || fault.id === 'no-tests' || fault.id === 'timeout'
        ? ['test:tools']
        : ['check'],
      { cwd: root },
    );
    reports.push({ id: fault.id, detected: true, repaired: true });
  }
  const library = workspacePackages(root).find((pkg) => pkg.runtime === 'library');
  if (!library) throw new Error('Boundary rehearsal requires a shared library');
  const boundary = path.join(root, library.directory, 'src/boundary-fault.ts');
  writeFileSync(
    boundary,
    "import { readFileSync } from 'node:fs';\nexport const boundaryFault = readFileSync;\n",
  );
  const result = await capture(root, ['exec', 'node', 'tools/quality/structure.ts']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /runtime boundary violation/u);
  rmSync(boundary);
  await pnpm(['check'], { cwd: root });
  reports.push({ id: 'boundary', detected: true, repaired: true });
  const metadata = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as {
    version: string;
  };
  writeFileSync(
    path.join(root, 'artifacts/faults.json'),
    `${JSON.stringify({ version: metadata.version, reports }, null, 2)}\n`,
  );
}
