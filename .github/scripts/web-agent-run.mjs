import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertInput } from './web-agent-input.mjs';

const [phase, ...argv] = process.argv.slice(2);
if (!phase || !argv.length) throw new Error('Phase and actual command are required');
if (argv.some((arg) => arg === '--no-verify' || arg.startsWith('core.hooksPath')))
  throw new Error('Hook bypass is forbidden');
if (phase === 'full' && argv.some((arg) => arg === '--checks' || arg.startsWith('--checks=')))
  throw new Error('Full support phase must use the complete selected configuration');
const directory = path.resolve('artifacts/agent-web-api');
mkdirSync(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
const commandsFile = path.join(directory, 'commands.json');
const commands = existsSync(commandsFile) ? JSON.parse(readFileSync(commandsFile, 'utf8')) : [];
const log = `logs/${String(commands.length + 1).padStart(2, '0')}-${phase}.log`;
const inputBefore = await assertInput(phase !== 'setup');
const fd = openSync(path.join(directory, log), 'w', 0o600);
const environment = Object.fromEntries(
  ['TMPDIR', 'TMP', 'TEMP', 'WRANGLER_LOG_PATH'].map((key) => [key, process.env[key] ?? null]),
);
const startedAt = new Date().toISOString();
const start = performance.now();
writeFileSync(
  fd,
  `${JSON.stringify({ phase, argv, cwd: process.cwd(), inputBefore, environment, startedAt })}\n`,
);
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', fd, fd], env: process.env });
let spawnError = null;
child.on('error', (error) => {
  spawnError = String(error);
  writeFileSync(fd, `${spawnError}\n`);
});
const completed = await new Promise((resolve) =>
  child.once('close', (exit, signal) => resolve({ exit, signal })),
);
let inputAfter = null;
let inputGuardError = null;
try {
  inputAfter = await assertInput();
} catch (error) {
  inputGuardError = String(error);
}
const entry = {
  phase,
  argv,
  exit: completed.exit ?? 1,
  signal: completed.signal,
  spawnError,
  inputBefore,
  inputAfter,
  inputGuardError,
  environment,
  cwd: process.cwd(),
  startedAt,
  milliseconds: Math.round(performance.now() - start),
  log,
};
writeFileSync(fd, `\n${JSON.stringify(entry)}\n`);
closeSync(fd);
commands.push(entry);
writeFileSync(commandsFile, `${JSON.stringify(commands, null, 2)}\n`);
console.log(JSON.stringify(entry));
process.exitCode = entry.exit !== 0 ? entry.exit : inputGuardError ? 1 : 0;
