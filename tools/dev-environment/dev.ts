import path from 'node:path';
import { once } from 'node:events';
import { workspacePackages } from '../quality/graph.ts';
import { Servers } from './servers.ts';

const root = process.cwd();
const packages = workspacePackages(root);
const target = process.argv[2];
const chosen = target
  ? packages.filter((pkg) => pkg.name === target || path.basename(pkg.directory) === target)
  : packages.filter((pkg) => pkg.runtime !== 'library');
if (!chosen.length)
  throw new Error(`No runnable application matches ${target ?? 'the selected configuration'}`);
const servers = new Servers(root);
const stop = () => {
  void servers.stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (const pkg of chosen) {
    if (pkg.runtime === 'worker') await servers.workers(pkg.name);
    else if (pkg.runtime === 'desktop') {
      // Tauri's own beforeDevCommand starts its renderer at the configured port.
      // Native launcher passes a worktree-local devUrl override; no other server is terminated.
      await servers.start(pkg, 'dev:renderer');
      const { pnpmCommand } = await import('../process.ts');
      const { spawn } = await import('node:child_process');
      const invocation = pnpmCommand([
        '--filter',
        pkg.name,
        'exec',
        'tauri',
        'dev',
        '--config',
        JSON.stringify({ build: { beforeDevCommand: '', devUrl: servers.origins.get(pkg.name) } }),
      ]);
      const child = spawn(invocation.command, invocation.args, {
        cwd: root,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      servers.children.push(child);
      child.once('error', (error) => servers.failures.push(error));
      child.once('exit', (code, signal) => {
        if (!servers.stopping && code !== 0 && signal !== 'SIGTERM')
          servers.failures.push(new Error(`${pkg.name} native exit ${code}, signal ${signal}`));
      });
    }
  }
  await Promise.race(
    servers.children.map((child) =>
      child.exitCode === null ? once(child, 'exit') : Promise.resolve(),
    ),
  );
  if (servers.failures.length) throw new AggregateError(servers.failures);
} finally {
  await servers.stop();
}
