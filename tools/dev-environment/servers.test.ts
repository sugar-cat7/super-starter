import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Servers } from './servers.ts';

it('cancels a pending start before spawn and permits an explicit real-server restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-cancel-'));
  const servers = new Servers(root);
  const pkg = {
    name: 'startup-fixture',
    directory: '.',
    runtime: 'library' as const,
    dependencies: [],
    scripts: { dev: 'node server.cjs' },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, scripts: pkg.scripts }),
  );
  writeFileSync(
    path.join(root, 'server.cjs'),
    "require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.env.STARTER_PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+process.env.STARTER_PORT));\n",
  );
  try {
    const pending = servers.start(pkg);
    await Promise.all([expect(pending).rejects.toThrow('cancelled by stop'), servers.stop()]);
    expect(servers.children).toHaveLength(0);
    const origin = await servers.start(pkg);
    expect(await (await fetch(origin)).text()).toBe('ready');
    await servers.stop();
    expect(servers.children).toHaveLength(0);
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      'fetch failed',
    );
  } finally {
    await servers.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
