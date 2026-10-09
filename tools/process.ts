import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

export async function stopTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    if (child.exitCode === null)
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    return;
  }
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const started = performance.now();
  while (signal(0) && performance.now() - started < 3_000) await pause(50);
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
  options: SpawnOptions & { timeout?: number } = {},
): Promise<void> {
  const { timeout = 10 * 60_000, ...spawnOptions } = options;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      ...spawnOptions,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree(child).catch(reject);
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else
        void stopTree(child).then(
          () =>
            reject(
              new Error(
                `${command} ${args.join(' ')}: ${timedOut ? 'timeout' : `exit ${code}, signal ${signal}`}`,
              ),
            ),
          reject,
        );
    });
  });
}

export async function pnpm(
  args: string[],
  options: SpawnOptions & { timeout?: number } = {},
): Promise<void> {
  const invocation = pnpmCommand(args);
  await run(invocation.command, invocation.args, options);
}
