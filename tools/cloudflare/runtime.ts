import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Servers } from '../dev-environment/servers.ts';
import { pnpm } from '../process.ts';

const root = path.resolve(process.cwd(), '../..');
const state = mkdtempSync(path.join(os.tmpdir(), 'starter-runtime-'));
const servers = new Servers(root, state);
try {
  const origin = await servers.workers(path.basename(process.cwd()));
  await pnpm(
    ['exec', 'node', '../../tools/quality/vitest.ts', '--config', 'vitest.runtime.config.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, STARTER_TEST_ORIGIN: origin },
      timeout: 120_000,
    },
  );
  if (servers.failures.length) throw new AggregateError(servers.failures);
} finally {
  await servers.stop();
  rmSync(state, { recursive: true, force: true });
}
