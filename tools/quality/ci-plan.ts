import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { affectedPackages, workspacePackages } from './graph.ts';
import { packageChecks } from './definitions.ts';
import { contentId } from './gate.ts';
import { pnpm } from '../process.ts';
import { verificationCases } from '../generators/options.ts';

export function ciPlan(root: string, base?: string) {
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error('CI planning requires the exact checkout commit');
  const diff =
    base && !/^0+$/u.test(base)
      ? git(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`])
      : undefined;
  const changed = diff?.status === 0 ? diff.stdout.split('\0').filter(Boolean) : undefined;
  const selected = affectedPackages(workspacePackages(root), changed);
  const fixtures =
    changed === undefined || changed.some((filename) => !filename.startsWith('packages/'));
  const native = selected.some((pkg) => pkg.runtime === 'desktop');
  const workers = selected.some((pkg) => pkg.runtime === 'worker');
  const observability =
    changed === undefined ||
    changed.some(
      (file) =>
        !file.endsWith('.md') &&
        /^(?:packages\/|tools\/(?:o11y|errors|generators|quality)\/|\.github\/workflows\/quality\.yml$|(?:pnpm|mise|vite|package)[^/]*\.(?:yaml|toml|json|ts)$)/u.test(
          file,
        ),
    );
  return {
    schema: 1,
    sha: head.stdout.trim(),
    base: base ?? null,
    contentId: contentId(root),
    changed: changed ?? null,
    selected: selected.map((pkg) => pkg.name),
    checks: selected.flatMap((pkg) => packageChecks(pkg, 'full').map((check) => check.id)),
    fixtures,
    native,
    workers,
    observability,
    reason:
      changed === undefined
        ? 'Unknown base requires the complete configuration'
        : 'Committed diff and reverse dependency graph; root infrastructure changes require all fixtures',
    nativeMatrix: {
      include: native ? [{ os: 'ubuntu-24.04' }, { os: 'macos-15' }, { os: 'windows-2025' }] : [],
    },
    fixturesMatrix: {
      include: fixtures
        ? [
            ...verificationCases.map((entry) => ({ preset: entry.key, os: 'ubuntu-24.04' })),
            { preset: 'desktop', os: 'macos-15' },
            { preset: 'desktop', os: 'windows-2025' },
          ]
        : [],
    },
  };
}

if (process.argv[1]?.endsWith(`${path.sep}ci-plan.ts`)) {
  const root = process.cwd();
  const plan = ciPlan(root, process.env.CI_BASE_SHA);
  if (process.argv[2] === 'browsers') {
    for (const pkg of workspacePackages(root).filter(
      (pkg) => plan.selected.includes(pkg.name) && pkg.scripts['test:e2e'],
    ))
      await pnpm(
        ['--filter', pkg.name, 'exec', 'playwright', 'install', '--with-deps', 'chromium'],
        { cwd: root },
      );
  } else if (process.argv[2]) throw new Error('Expected plan (no argument) or browsers');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(root, 'artifacts/ci-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries({
      fixtures: String(plan.fixtures),
      native: String(plan.native),
      workers: String(plan.workers),
      observability: String(plan.observability),
      native_matrix: JSON.stringify(plan.nativeMatrix),
      fixtures_matrix: JSON.stringify(plan.fixturesMatrix),
    }))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
