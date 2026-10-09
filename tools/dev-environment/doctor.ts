import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspacePackages } from '../quality/graph.ts';
import { pnpmCommand } from '../process.ts';

export function doctor(root: string): { id: string; ok: boolean; detail: string }[] {
  const tools = readFileSync(path.join(root, 'mise.toml'), 'utf8');
  const nodeVersion = /^node = "(\d+\.\d+\.\d+)"$/mu.exec(tools)?.[1];
  const aquaVersion = /^"aqua:pnpm\/pnpm" = "(\d+\.\d+\.\d+)"$/mu.exec(tools)?.[1];
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(manifest.packageManager ?? '')?.[1];
  if (!nodeVersion || !aquaVersion || !pnpmVersion)
    throw new Error('Exact Node/aqua pnpm/packageManager versions are required');
  const checks = [
    {
      id: 'node',
      ok: process.versions.node === nodeVersion,
      detail: `Node ${process.versions.node}; required ${nodeVersion} (mise install)`,
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
    ok:
      manager.status === 0 && manager.stdout.trim() === pnpmVersion && aquaVersion === pnpmVersion,
    detail: `pnpm ${pnpmVersion} required (mise install aqua:pnpm/pnpm@${pnpmVersion}); mise pin ${aquaVersion}`,
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
      const rustVersion = /^channel = "(\d+\.\d+\.\d+)"$/mu.exec(
        readFileSync(path.join(cwd, 'src-tauri/rust-toolchain.toml'), 'utf8'),
      )?.[1];
      if (!rustVersion) throw new Error(`Exact Rust toolchain version required: ${pkg.name}`);
      // rustc, unlike rustup show, does not silently install missing toolchains.
      const rust = spawnSync('rustc', ['--version'], {
        cwd: path.join(cwd, 'src-tauri'),
        env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      checks.push({
        id: `${pkg.name}/rust`,
        ok: rust.status === 0 && rust.stdout.startsWith(`rustc ${rustVersion} `),
        detail: `Rust ${rustVersion} required; see docs/native.md for OS prerequisites`,
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
