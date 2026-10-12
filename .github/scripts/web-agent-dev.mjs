import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { assertInput } from './web-agent-input.mjs';

const directory = path.resolve('artifacts/agent-web-api');
mkdirSync(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
const commandsFile = path.join(directory, 'commands.json');
const commands = existsSync(commandsFile) ? JSON.parse(readFileSync(commandsFile, 'utf8')) : [];
const log = `logs/${String(commands.length + 1).padStart(2, '0')}-dev.log`;
const inputBefore = await assertInput();
const { spawnOwned, pnpmCommand, stopTree } = await import(
  pathToFileURL(path.resolve('tools/process.ts')).href
);
const argv = ['pnpm', 'dev', '--', 'web'];
const command = pnpmCommand(argv.slice(1));
const startedAt = new Date().toISOString();
const start = performance.now();
const child = spawnOwned(command.command, command.args, {
  cwd: process.cwd(),
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
let output = '';
let failure = null;
let exit = 1;
let created = null;
let origin = null;
const checks = {};
child.stdout?.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr?.on('data', (chunk) => {
  output += chunk.toString();
});
child.once('error', (error) => {
  failure = String(error);
});
const request = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  return response;
};
try {
  // Root dev retains its own per-server readiness deadline. This outer guard
  // only bounds observation/cleanup if the launcher itself stops responding.
  while (!origin && performance.now() - start < 180_000) {
    if (child.exitCode !== null || child.signalCode !== null || failure)
      throw new Error('Standard dev exited before Web READY');
    const match = output.match(/READY @independent-web\/web (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match) origin = match[1];
    else await pause(100);
  }
  if (!origin) throw new Error('Standard dev never declared Web READY');
  const countResponse = await request(`${origin}/api/notes/count`);
  if (
    countResponse.status !== 200 ||
    countResponse.headers.get('x-storage-mode') !== 'persistent-d1'
  )
    throw new Error('Actual D1 count read failed');
  const before = (await countResponse.json()).count;
  if (!Number.isSafeInteger(before) || before < 0) throw new Error('Invalid live count');
  const listResponse = await request(`${origin}/api/notes`);
  if (listResponse.status !== 200 || (await listResponse.json()).length !== before)
    throw new Error('Count and actual list disagree');
  const response = await request(`${origin}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Owned hosted count rehearsal' }),
  });
  if (response.status !== 201) throw new Error('Actual note create failed');
  created = (await response.json()).id;
  if ((await (await request(`${origin}/api/notes/count`)).json()).count !== before + 1)
    throw new Error('Count did not increase');
  if ((await request(`${origin}/api/notes/${created}`, { method: 'DELETE' })).status !== 204)
    throw new Error('Actual note delete failed');
  created = null;
  if ((await (await request(`${origin}/api/notes/count`)).json()).count !== before)
    throw new Error('Count did not return to baseline');
  const html = await (await request(`${origin}/`)).text();
  if (!html.includes('Counting notes') || !html.includes('New note'))
    throw new Error('Styled SSR missing feature/form');
  if (!(await (await request(`${origin}/health`)).json()).ok)
    throw new Error('Actual health failed');
  Object.assign(checks, {
    before,
    countAfterDelete: before,
    d1: true,
    serviceBinding: true,
    SSR: true,
  });
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error('Dev exited during actual smoke');
  exit = 0;
} catch (error) {
  failure = String(error);
} finally {
  if (created && origin) {
    try {
      if ((await request(`${origin}/api/notes/${created}`, { method: 'DELETE' })).status !== 204) {
        failure = 'Owned note cleanup failed';
        exit = 1;
      }
    } catch (error) {
      failure = String(error);
      exit = 1;
    }
  }
  try {
    child.kill('SIGINT');
    await stopTree(child);
  } catch (error) {
    failure = String(error);
    exit = 1;
  }
  let inputAfter = null;
  try {
    inputAfter = await assertInput();
  } catch (error) {
    failure = String(error);
    exit = 1;
  }
  const entry = {
    phase: 'dev',
    argv,
    exit,
    startedAt,
    milliseconds: Math.round(performance.now() - start),
    log,
    inputBefore,
    inputAfter,
    processExit: child.exitCode,
    processSignal: child.signalCode,
    failure,
    checks,
    cleanup: exit === 0 ? 'passed' : 'failed',
    completion:
      'Standard Web dev READY and real HTTP/SSR count CRUD smoke, followed by deliberate owned shutdown',
  };
  writeFileSync(
    path.join(directory, log),
    `${JSON.stringify({ argv, inputBefore, startedAt })}\n${output}\n${JSON.stringify(entry)}\n`,
    { mode: 0o600 },
  );
  commands.push(entry);
  writeFileSync(commandsFile, `${JSON.stringify(commands, null, 2)}\n`);
  console.log(JSON.stringify(entry));
  process.exitCode = exit;
}
