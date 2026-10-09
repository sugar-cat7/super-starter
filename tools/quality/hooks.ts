import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { pnpm, runSync } from '../process.ts';
import { workspacePackages } from './graph.ts';

const hookPath = 'tools/quality/git-hooks';
export function installHooks(root: string): void {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) {
    console.log('Hooks not_required: no Git repository (run env:setup after git init)');
    return;
  }
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  if (configured && configured !== hookPath)
    throw new Error(
      `Existing core.hooksPath ${configured}; preserve it and explicitly migrate before installing repository hooks`,
    );
  if (!configured) {
    const defaults = runSync('git', ['rev-parse', '--git-path', 'hooks'], root);
    const directory = path.resolve(root, defaults);
    if (
      existsSync(directory) &&
      readdirSync(directory).some(
        (filename) =>
          !filename.endsWith('.sample') && lstatSync(path.join(directory, filename)).isFile(),
      )
    )
      throw new Error(
        'Existing user hooks found in Git hooks directory; explicit migration required',
      );
  }
  runSync('git', ['config', '--local', 'core.hooksPath', hookPath], root);
  for (const event of ['pre-commit', 'pre-push'])
    chmodSync(path.join(root, hookPath, event), 0o755);
  console.log('Repository-local Git hooks installed');
}

function linkDependencies(
  source: string,
  destination: string,
  originalRoot: string,
  snapshot: string,
): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      linkDependencies(from, to, originalRoot, snapshot);
      continue;
    }
    const resolved = realpathSync(from);
    if (!lstatSync(resolved).isDirectory()) {
      copyFileSync(resolved, to);
      continue;
    }
    const relative = path.relative(originalRoot, resolved);
    const replacement =
      relative.startsWith(`packages${path.sep}`) &&
      !relative.includes(`${path.sep}node_modules${path.sep}`)
        ? path.join(snapshot, relative)
        : resolved;
    symlinkSync(
      replacement,
      to,
      entry.isDirectory() || lstatSync(resolved).isDirectory() ? 'junction' : 'file',
    );
  }
}

export async function indexCheck(root: string): Promise<void> {
  const snapshot = mkdtempSync(path.join(os.tmpdir(), 'starter-index-'));
  try {
    runSync(
      'git',
      ['checkout-index', '--all', `--prefix=${snapshot.split(path.sep).join('/')}/`],
      root,
    );
    linkDependencies(
      path.join(root, 'node_modules'),
      path.join(snapshot, 'node_modules'),
      root,
      snapshot,
    );
    for (const pkg of workspacePackages(snapshot))
      linkDependencies(
        path.join(root, pkg.directory, 'node_modules'),
        path.join(snapshot, pkg.directory, 'node_modules'),
        root,
        snapshot,
      );
    await pnpm(['exec', 'vp', 'fmt', '--check'], { cwd: snapshot, timeout: 120_000 });
    // Staged checks intentionally use lint rather than worktree typegen/runtime.
    await pnpm(['exec', 'vp', 'lint'], {
      cwd: snapshot,
      env: { ...process.env, STARTER_CHECK_PHASE: 'index' },
      timeout: 120_000,
    });
    await pnpm(['exec', 'node', 'tools/quality/structure.ts'], { cwd: snapshot, timeout: 120_000 });
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith(`${path.sep}hooks.ts`)) {
  const root = runSync('git', ['rev-parse', '--show-toplevel'], process.cwd());
  const event = process.argv[2];
  if (event === 'install') installHooks(root);
  else if (event === 'pre-commit') await indexCheck(root);
  else if (event === 'pre-push') {
    let input = '';
    for await (const chunk of process.stdin) input += String(chunk);
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const [, local, , remote] = line.split(' ');
      if (!local || /^0+$/u.test(local)) continue;
      // Validate the actual pushed commit, including when HEAD is different.
      const snapshot = mkdtempSync(path.join(os.tmpdir(), 'starter-push-'));
      rmSync(snapshot, { recursive: true });
      try {
        runSync('git', ['worktree', 'add', '--detach', snapshot, local], root);
        await pnpm(['install', '--frozen-lockfile'], { cwd: snapshot });
        await pnpm(['env:setup'], { cwd: snapshot });
        runSync('git', ['diff', '--exit-code', local], snapshot);
        await pnpm(
          ['gate:push', '--', '--base', remote && !/^0+$/u.test(remote) ? remote : 'unknown'],
          { cwd: snapshot },
        );
      } finally {
        runSync('git', ['worktree', 'remove', '--force', snapshot], root);
      }
    }
  } else throw new Error(`Unknown hook event: ${event}`);
}
