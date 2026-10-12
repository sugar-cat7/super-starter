import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [phase, ...argv] = process.argv.slice(2);
if (!phase || !argv.length) throw new Error('phase and command required');
const directory = path.resolve('artifacts/agent-desktop');
mkdirSync(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
const reportFile = path.join(directory, 'commands.json');
const reports = (() => {
  try {
    return JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    return [];
  }
})();
const filename = `logs/${String(reports.length + 1).padStart(2, '0')}-${phase}.log`;
const fd = openSync(path.join(directory, filename), 'w', 0o600);
const start = performance.now();
const startedAt = new Date().toISOString();
const child = spawn(argv[0], argv.slice(1), {
  stdio: ['ignore', fd, fd],
  env: process.env,
  shell: process.platform === 'win32' && /^(pnpm|mise)$/u.test(argv[0]),
});
child.on('error', (error) => {
  writeFileSync(fd, String(error));
});
child.on('close', (exit, signal) => {
  closeSync(fd);
  const entry = {
    phase,
    argv,
    exit: exit ?? 1,
    signal,
    startedAt,
    milliseconds: Math.round(performance.now() - start),
    os: process.platform,
    environment: Object.fromEntries(
      ['TMPDIR', 'GIT_CEILING_DIRECTORIES', 'CARGO_TARGET_DIR']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
    log: filename,
  };
  reports.push(entry);
  writeFileSync(reportFile, `${JSON.stringify(reports, null, 2)}\n`);
  console.log(JSON.stringify(entry));
  process.exitCode = entry.exit;
});
