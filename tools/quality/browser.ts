import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Servers } from '../dev-environment/servers.ts';
import { pnpm } from '../process.ts';
import { browserCases } from './test-results.ts';

const state = mkdtempSync(path.join(os.tmpdir(), 'starter-browser-'));
const servers = new Servers(path.resolve(process.cwd(), '../..'), state);
try {
  const evidence = path.resolve(process.cwd(), '../../artifacts/browser.json');
  rmSync(evidence, { force: true });
  const origin = await servers.workers(path.basename(process.cwd()));
  await pnpm(
    [
      'exec',
      'playwright',
      'test',
      ...process.argv.slice(2).filter((argument) => argument !== '--'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, STARTER_TEST_ORIGIN: origin },
      timeout: 180_000,
    },
  );
  console.log(
    `Executed ${browserCases(JSON.parse(readFileSync(evidence, 'utf8')) as unknown)} required browser cases`,
  );
  if (servers.failures.length) throw new AggregateError(servers.failures);
} finally {
  await servers.stop();
  rmSync(state, { recursive: true, force: true });
}
