import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pnpmCommand, stopTree } from '../process.ts';
export { stopTree } from '../process.ts';
import { workspacePackages, type WorkspacePackage } from '../quality/graph.ts';
import { prepareDatabase } from '../cloudflare/database.ts';

export async function availablePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === 'string') reject(new Error('Unable to allocate port'));
      else resolve(address.port);
    });
  });
}

export class Servers {
  children: ChildProcess[] = [];
  origins = new Map<string, string>();
  failures: Error[] = [];
  readonly root: string;
  readonly stateRoot: string;
  stopping = false;
  constructor(root: string, stateRoot = path.join(root, '.state')) {
    this.root = root;
    this.stateRoot = stateRoot;
  }
  async start(pkg: WorkspacePackage, script = 'dev'): Promise<string> {
    const port = await availablePort();
    this.stopping = false;
    if (pkg.runtime === 'worker')
      await prepareDatabase(path.join(this.root, pkg.directory), this.stateRoot);
    const invocation = pnpmCommand(['--filter', pkg.name, script]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        STARTER_PORT: String(port),
        STARTER_STATE_ROOT: this.stateRoot,
        WRANGLER_REGISTRY_PATH: path.join(this.stateRoot, 'registry'),
        CLOUDFLARE_SEND_METRICS: 'false',
      },
    });
    this.children.push(child);
    let output = '';
    const log = (chunk: Buffer) => {
      const message = chunk.toString();
      output = (output + message).slice(-20_000);
      process.stdout.write(`[${pkg.name}] ${message}`);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    let exited = false;
    child.once('error', (error) => {
      exited = true;
      this.failures.push(error);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (!this.stopping && code !== 0 && signal !== 'SIGTERM')
        this.failures.push(new Error(`${pkg.name}: exit ${code}, signal ${signal}`));
    });
    const origin = `http://127.0.0.1:${port}`;
    const started = performance.now();
    while (performance.now() - started < 90_000) {
      if (exited) throw new Error(`${pkg.name} exited before ready\n${output}`);
      try {
        const response = await fetch(`${origin}${pkg.runtime === 'worker' ? '/health' : '/'}`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          this.origins.set(pkg.name, origin);
          console.log(`READY ${pkg.name} ${origin} ${Math.round(performance.now() - started)}ms`);
          return origin;
        }
      } catch {
        /* Wait only for the owned server; strictPort reports collisions. */
      }
      await pause(200);
    }
    throw new Error(`${pkg.name} ready timeout\n${output}`);
  }
  async workers(target: string): Promise<string> {
    const packages = workspacePackages(this.root);
    const pkg = packages.find(
      (value) =>
        value.name === target ||
        value.directory === target ||
        path.basename(value.directory) === target,
    );
    if (!pkg || pkg.runtime !== 'worker') throw new Error(`Unknown Worker: ${target}`);
    for (const dependency of pkg.dependencies) {
      const upstream = packages.find((value) => value.name === dependency);
      if (upstream?.runtime === 'worker' && !this.origins.has(upstream.name))
        await this.workers(upstream.name);
    }
    return this.origins.get(pkg.name) ?? (await this.start(pkg));
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.children.toReversed().map((child) => stopTree(child)));
    this.children = [];
    this.origins.clear();
  }
}
