import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Servers } from '../dev-environment/servers.ts';
import { pnpm } from '../process.ts';

const state = mkdtempSync(path.join(os.tmpdir(), 'starter-browser-'));
const servers = new Servers(path.resolve(process.cwd(), '../..'), state);
try {
  const origin = await servers.workers(path.basename(process.cwd()));
  await pnpm(['exec', 'playwright', 'test', ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, STARTER_TEST_ORIGIN: origin },
    timeout: 180_000,
  });
  if (servers.failures.length) throw new AggregateError(servers.failures);
} finally {
  await servers.stop();
  rmSync(state, { recursive: true, force: true });
}
