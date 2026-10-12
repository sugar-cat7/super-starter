import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import path from 'node:path';
import { assertExpectedInput } from './desktop-agent-input.ts';
import { spawnOwned, pnpmCommand, stopTree } from '../../tools/process.ts';

const directory = path.resolve('artifacts/agent-desktop');
mkdirSync(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
const reports = JSON.parse(
  readFileSync(path.join(directory, 'commands.json'), 'utf8'),
) as unknown[];
const log = `logs/${String(reports.length + 1).padStart(2, '0')}-dev.log`;
const argv = ['pnpm', 'dev', '--', 'desktop'];
const command = pnpmCommand(argv.slice(1));
const inputBefore = assertExpectedInput();
const start = performance.now();
const startedAt = new Date().toISOString();
const child = spawnOwned(command.command, command.args, {
  cwd: process.cwd(),
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CARGO_TARGET_DIR: path.resolve('.state/desktop/target-release') },
});
let output = '';
let error = '';
let exit = 1;
child.stdout?.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});
child.stderr?.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});
child.once('error', (failure) => {
  error = String(failure);
});
try {
  while (!output.includes('NATIVE_READY') && performance.now() - start < 30 * 60000) {
    if (child.exitCode !== null || child.signalCode !== null || error)
      throw new Error(`Dev failed before native readiness: ${error}`);
    await pause(100);
  }
  if (!output.includes('NATIVE_READY')) throw new Error('Native dev readiness timeout');
  await pause(1000);
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error('Dev exited after native readiness');
  child.kill('SIGINT');
  await stopTree(child);
  exit = 0;
} catch (failure) {
  error = String(failure);
  await stopTree(child);
} finally {
  writeFileSync(path.join(directory, log), `${output}\n${error}\n`, { mode: 0o600 });
  const entry = {
    phase: 'dev',
    inputBefore,
    inputAfter: assertExpectedInput(),
    completion: 'Actual native readiness followed by deliberate shutdown and owned process cleanup',
    processExitCode: child.exitCode,
    processSignal: child.signalCode,
    environment: {
      TMPDIR: process.env.TMPDIR,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    },
    argv,
    exit,
    startedAt,
    milliseconds: Math.round(performance.now() - start),
    os: process.platform,
    log,
    nativeReady: output.includes('NATIVE_READY'),
    cleanup: exit === 0 ? 'passed' : 'failed',
  };
  reports.push(entry);
  writeFileSync(path.join(directory, 'commands.json'), `${JSON.stringify(reports, null, 2)}\n`);
  console.log(JSON.stringify(entry));
  process.exitCode = exit;
}
