import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspacePackages } from '../quality/graph.ts';
import { pnpmCommand } from '../process.ts';

export function doctor(root: string): { id: string; ok: boolean; detail: string }[] {
  const checks = [
    {
      id: 'node',
      ok: process.versions.node === '24.19.0',
      detail: `Node ${process.versions.node}; required 24.19.0 (mise install)`,
    },
  ];
  const invocation = pnpmCommand(['--version']);
  const manager = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  checks.push({
    id: 'pnpm',
    ok: manager.status === 0 && manager.stdout.trim() === '12.10.1',
    detail: 'pnpm 12.10.1 required (mise install aqua:pnpm/pnpm@12.10.1)',
  });
  checks.push({
    id: 'vite-plus',
    ok: existsSync(path.join(root, 'node_modules/vite-plus/package.json')),
    detail: 'Project-local Vite+ required (pnpm install --frozen-lockfile)',
  });
  checks.push({
    id: 'initialized',
    ok: existsSync(path.join(root, '.template.json')),
    detail: 'Template state required (README cold start)',
  });
  for (const pkg of workspacePackages(root)) {
    const cwd = path.join(root, pkg.directory);
    if (pkg.runtime === 'worker')
      checks.push({
        id: `${pkg.name}/types`,
        ok: existsSync(path.join(cwd, '.cloudflare/types/index.d.ts')),
        detail: 'Local Worker types required (pnpm env:setup); no cloud credentials needed',
      });
    if (pkg.runtime === 'desktop') {
      // rustc, unlike rustup show, does not silently install missing toolchains.
      const rust = spawnSync('rustc', ['--version'], {
        cwd: path.join(cwd, 'src-tauri'),
        env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      checks.push({
        id: `${pkg.name}/rust`,
        ok: rust.status === 0 && rust.stdout.startsWith('rustc 1.98.1 '),
        detail: 'Rust 1.98.1 required; see docs/native.md for OS prerequisites',
      });
      if (process.platform === 'linux') {
        const native = spawnSync('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1'], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        checks.push({
          id: `${pkg.name}/native-libraries`,
          ok: native.status === 0,
          detail:
            'GTK3/WebKitGTK4.1 required; install listed OS libraries through your existing environment provisioning',
        });
      }
    }
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (git.status === 0) {
    const hook = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    checks.push({
      id: 'hooks',
      ok: hook.stdout.trim() === 'tools/quality/git-hooks',
      detail:
        'Repository hooks required (pnpm env:setup); existing hook conflicts require explicit migration',
    });
  }
  // Read the manifest to catch corrupt state; never inspect values of runtime secrets.
  if (existsSync(path.join(root, '.template.json')))
    JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8'));
  return checks;
}

if (process.argv[1]?.endsWith(`${path.sep}doctor.ts`)) {
  const checks = doctor(process.cwd());
  console.log(JSON.stringify({ os: process.platform, checks }, null, 2));
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
