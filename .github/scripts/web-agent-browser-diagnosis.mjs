import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { assertInput } from './web-agent-input.mjs';

const inputBefore = await assertInput();
const load = createRequire(path.resolve('packages/web/package.json'));
const browser = load('@playwright/test').chromium.executablePath();
const flags = [
  ...createRequire(load.resolve('lighthouse'))('chrome-launcher').Launcher.defaultFlags(),
  '--enable-features=DevToolsWebMCPSupport',
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--remote-debugging-address=127.0.0.1',
];
const { spawnOwned, stopTree } = await import(pathToFileURL(path.resolve('tools/process.ts')).href);
const { availablePort } = await import(
  pathToFileURL(path.resolve('tools/dev-environment/servers.ts')).href
);
const directory = path.resolve('artifacts/agent-web-api');
const attempts = [];
for (const [label, temporary] of [
  ['original', path.resolve('.state/agent-tmp')],
  ['short-owned', path.resolve('.state/t')],
]) {
  mkdirSync(temporary, { recursive: true });
  const profile = mkdtempSync(path.join(temporary, 'browser-diagnosis-'));
  const port = await availablePort();
  const argv = [...flags, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  const environment = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawnOwned(browser, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '',
    error = null,
    ready = false,
    cleanup = null;
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (failure) => {
    error = String(failure);
  });
  try {
    while (performance.now() - started < 30_000) {
      if (error || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok && (await response.json()).webSocketDebuggerUrl) {
          ready = true;
          break;
        }
      } catch {
        /* Same owned-browser readiness probe as the canonical runner. */
      }
      await pause(100);
    }
  } finally {
    try {
      await stopTree(child, 1_000);
      cleanup = 'passed';
    } catch (failure) {
      cleanup = String(failure);
    }
    rmSync(profile, { recursive: true, force: true });
  }
  const entry = {
    label,
    argv: [browser, ...argv],
    temporary,
    temporaryBytes: Buffer.byteLength(temporary),
    startedAt,
    milliseconds: Math.round(performance.now() - started),
    ready,
    error,
    stdout,
    stderr,
    processExit: child.exitCode,
    processSignal: child.signalCode,
    cleanup,
  };
  attempts.push(entry);
  console.log(JSON.stringify(entry));
}
const inputAfter = await assertInput();
const report = {
  schema: 1,
  execution: 'hosted-tools',
  kind: 'browser-startup-diagnosis',
  scope: 'Mechanical diagnostic only; does not run Lighthouse audits or approve any Agent phase.',
  inputBefore,
  inputAfter,
  attempts,
};
writeFileSync(
  path.join(directory, 'browser-startup-diagnosis.json'),
  JSON.stringify(report, null, 2) + '\n',
);
if (attempts.some((attempt) => attempt.error || attempt.cleanup !== 'passed')) process.exitCode = 1;
