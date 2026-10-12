import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertInput } from './web-agent-input.mjs';

const directory = path.resolve('artifacts/agent-web-api');
const commands = [];
for (const target of ['api', 'web']) {
  const inputBefore = await assertInput();
  const argv = ['pnpm', 'deploy:preflight', '--', '--target', target, '--environment', 'dev'];
  const log = `logs/dev-${target}-preflight.log`;
  const fd = openSync(path.join(directory, log), 'w', 0o600);
  const startedAt = new Date().toISOString(), start = performance.now();
  writeFileSync(fd, JSON.stringify({ argv, inputBefore, startedAt, cwd: process.cwd() }) + '\n');
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', fd, fd], env: process.env });
  let spawnError = null;
  child.once('error', error => { spawnError = String(error); });
  const completion = await new Promise(resolve => child.once('close', (exit, signal) => resolve({ exit, signal })));
  closeSync(fd);
  const inputAfter = await assertInput();
  const raw = readFileSync(path.join(directory, log), 'utf8');
  const blocked = completion.exit === 1 && !completion.signal && !spawnError &&
    (target === 'api' ? raw.includes('D1_DATABASE_ID') : raw.includes('CLOUDFLARE_ACCOUNT_ID'));
  const entry = { phase: 'preflight-dev', argv, ...completion, spawnError, inputBefore, inputAfter, startedAt,
    milliseconds: Math.round(performance.now() - start), log, target,
    status: completion.exit === 0 ? 'passed' : blocked ? 'blocked-missing-approved-resources' : 'failed',
    scope: 'Dev connection observation; nonzero CLI remains blocked and is not successful mandatory local preflight evidence.' };
  commands.push(entry);
  writeFileSync(path.join(directory, 'dev-preflight-observations.json'), JSON.stringify({ execution: 'hosted-tools', commands }, null, 2) + '\n');
  console.log(JSON.stringify(entry));
  if (entry.status === 'failed') process.exitCode = 1;
}
