import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertInput } from './web-agent-input.mjs';

export const directory = path.resolve('artifacts/agent-web-api');
export const commandsFile = path.join(directory, 'commands.json');
export async function recordCommand(phase, argv, before, after, options = {}) {
  if (!argv.length || argv.some((arg) => arg === '--no-verify' || arg.startsWith('core.hooksPath')))
    throw new Error('Invalid or bypassing command');
  if (phase === 'full' && argv.some((arg) => arg === '--checks' || arg.startsWith('--checks=')))
    throw new Error('Full gate must be complete');
  mkdirSync(path.join(directory, 'logs'), { recursive: true });
  const commands = existsSync(commandsFile) ? JSON.parse(readFileSync(commandsFile, 'utf8')) : [];
  const log = `logs/${String(commands.length + 1).padStart(2, '0')}-${phase}.log`;
  const inputBefore = await before();
  const fd = openSync(path.join(directory, log), 'w', 0o600);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const environment = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP', 'WRANGLER_LOG_PATH'].map(key => [key, process.env[key] ?? null]));
  writeFileSync(fd, JSON.stringify({ phase, argv, inputBefore, cwd: process.cwd(), startedAt, environment }) + '\n');
  const child = spawn(argv[0], argv.slice(1), { stdio: [options.stdin === undefined ? 'ignore' : 'pipe', fd, fd], env: process.env });
  let spawnError = null;
  child.once('error', (error) => { spawnError = String(error); writeFileSync(fd, spawnError + '\n'); });
  if (options.stdin !== undefined) {
    child.stdin.once('error', (error) => { spawnError = String(error); writeFileSync(fd, spawnError + '\n'); });
    child.stdin.end(options.stdin);
  }
  const completion = await new Promise(resolve => child.once('close', (exit, signal) => resolve({ exit, signal })));
  let inputAfter = null, inputGuardError = null;
  try { inputAfter = await after(); } catch (error) { inputGuardError = String(error); }
  const entry = { phase, argv, ...completion, spawnError, inputBefore, inputAfter, inputGuardError, environment,
    cwd: process.cwd(), startedAt, milliseconds: Math.round(performance.now() - start), log };
  writeFileSync(fd, '\n' + JSON.stringify(entry) + '\n'); closeSync(fd);
  commands.push(entry); writeFileSync(commandsFile, JSON.stringify(commands, null, 2) + '\n');
  console.log(JSON.stringify(entry));
  if (entry.exit !== 0 || entry.signal || spawnError || inputGuardError)
    throw new Error(`Actual ${phase} failed: ${entry.exit}/${entry.signal ?? 'no signal'}; ${spawnError ?? inputGuardError ?? ''}`);
  return entry;
}
if (process.argv[1]?.endsWith('web-agent-run.mjs')) {
  const [phase, ...argv] = process.argv.slice(2);
  await recordCommand(phase, argv, assertInput, assertInput);
}
