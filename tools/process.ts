import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';

const owned = new WeakSet<ChildProcess>();
const quoteWindows = (value: string): string =>
  `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/u, '$&$&')}"`;

export function spawnOwned(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  let child: ChildProcess;
  if (process.platform === 'win32') {
    const script = readFileSync(new URL('./windows-job.ps1', import.meta.url), 'utf8');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      ...options,
      detached: false,
      env: {
        ...(options.env ?? process.env),
        STARTER_PROCESS_SPEC: Buffer.from(
          JSON.stringify({
            commandLine: [command, ...args].map(quoteWindows).join(' '),
          }),
        ).toString('base64'),
      },
    });
  } else child = spawn(command, args, { ...options, detached: true });
  owned.add(child);
  return child;
}

export async function stopTree(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (!child.pid) return;
  const pid = child.pid;
  if (!owned.has(child)) throw new Error('Cleanup requires a process started by spawnOwned');
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null)
      throw new Error('Unable to terminate the owned Windows Job host');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned Windows Job cleanup timeout')), 10000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return;
  }
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        // XNU excludes zombies from every killpg signal, including existence probes.
        // Only a complete, valid process table may establish that this owned group has stopped.
        const table = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
          encoding: 'utf8',
          timeout: 1_000,
        });
        if (table.error || table.status !== 0)
          throw new Error('Unable to inspect the owned Darwin process group', { cause: error });
        const members: string[] = [];
        const rows = table.stdout.split('\n').filter((line) => line.trim());
        if (!rows.length) throw new Error('Invalid Darwin process table', { cause: error });
        for (const row of rows) {
          const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(row);
          if (
            !fields ||
            !Number.isSafeInteger(Number(fields[1])) ||
            !Number.isSafeInteger(Number(fields[2])) ||
            !/^[HIRSTUZ?][+<>AELNSVWXs]*$/u.test(fields[3] ?? '')
          )
            throw new Error('Invalid Darwin process table', { cause: error });
          if (Number(fields[2]) === pid) {
            members.push(row.trim());
            if (!fields[3]?.startsWith('Z')) throw error;
          }
        }
        console.warn(`Stopped Darwin group ${pid}: ${JSON.stringify(members)}`);
        return false;
      }
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const started = performance.now();
  while (signal(0) && performance.now() - started < graceMs) await pause(50);
  if (signal(0)) signal('SIGKILL');
}

export function pnpmCommand(args: string[]): { command: string; args: string[] } {
  const executable = process.env.npm_execpath;
  if (executable?.match(/\.[cm]?js$/u))
    return { command: process.execPath, args: [executable, ...args] };
  return { command: executable ?? (process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'), args };
}

export function runSync(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export async function run(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout?: number; capture?: boolean; terminationGraceMs?: number } = {},
): Promise<string> {
  const { timeout = 10 * 60_000, capture = false, terminationGraceMs, ...spawnOptions } = options;
  return await new Promise<string>((resolve, reject) => {
    const child = spawnOwned(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: process.platform !== 'win32',
      ...spawnOptions,
    });
    let output = '';
    if (capture) {
      const record = (chunk: Buffer, stream: NodeJS.WriteStream) => {
        output = (output + chunk.toString()).slice(-2_000_000);
        stream.write(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => record(chunk, process.stdout));
      child.stderr?.on('data', (chunk: Buffer) => record(chunk, process.stderr));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree(child, terminationGraceMs).catch(reject);
    }, timeout);
    let cleanup: Promise<void> | undefined;
    child.once('exit', () => {
      clearTimeout(timer);
      cleanup = stopTree(child, terminationGraceMs);
      void cleanup.catch(reject);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      void stopTree(child, terminationGraceMs).then(() => reject(error), reject);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      void (cleanup ?? stopTree(child, terminationGraceMs)).then(() => {
        if (code === 0 && !timedOut) resolve(output);
        else
          reject(
            new Error(
              `${command} ${args.join(' ')}: ${timedOut ? 'timeout' : `exit ${code}, signal ${signal}`}`,
            ),
          );
      }, reject);
    });
  });
}

export async function pnpm(
  args: string[],
  options: SpawnOptions & { timeout?: number; terminationGraceMs?: number } = {},
): Promise<void> {
  const invocation = pnpmCommand(args);
  await run(invocation.command, invocation.args, options);
}
