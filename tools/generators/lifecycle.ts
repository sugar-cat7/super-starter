import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pnpm, run } from '../process.ts';
import { contentId } from '../quality/gate.ts';
import { Servers } from '../dev-environment/servers.ts';
import { workspacePackages } from '../quality/graph.ts';
import { lifecyclePhases } from '../quality/definitions.ts';
import { baselineDifferences } from './baseline.ts';
import { applyFiles } from './files.ts';
import { projectOptions } from './options.ts';
import { projectFiles } from './render.ts';

export async function lifecycleRehearsal(source: string): Promise<void> {
  let completed = false;
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-lifecycle-'));
  const root = path.join(owned, 'project');
  const reports: {
    id: string;
    status: 'passed' | 'failed';
    milliseconds: number;
    contentId: string;
  }[] = [];
  const phase = async (id: string, work: () => Promise<void>) => {
    const started = performance.now();
    let status: 'passed' | 'failed' = 'failed';
    try {
      await work();
      status = 'passed';
    } finally {
      reports.push({
        id,
        status,
        milliseconds: Math.round(performance.now() - started),
        contentId: contentId(root),
      });
    }
  };
  const cli = (args: string[], failure?: RegExp) => {
    const result = spawnSync(process.execPath, ['tools/generators/cli.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = `${result.stdout}${result.stderr}`;
    if (failure) {
      assert.notEqual(result.status, 0);
      assert.match(output, failure);
    } else assert.equal(result.status, 0, output);
  };
  try {
    const options = projectOptions({
      name: 'separate-workspace',
      scope: '@separate',
      preset: 'web',
    });
    applyFiles(root, projectFiles(source, options));
    await phase('cold-setup', async () => {
      await pnpm(['env:setup'], { cwd: root });
      await pnpm(['env:doctor'], { cwd: root });
    });
    await phase('cold-gate', async () => {
      await pnpm(['gate:full'], { cwd: root });
    });
    await phase('hmr', async () => {
      const filename = path.join(root, 'packages/web/test/browser/hmr.spec.ts');
      writeFileSync(
        filename,
        "import { test, expect } from '@playwright/test';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\ntest('isolated HMR preserves the running hydrated page', async ({ page }) => { const file=path.resolve('src/routes/about.tsx'); const original=readFileSync(file,'utf8'); try { await page.goto('/about'); await expect(page.getByRole('heading',{name:'About this sample'})).toBeVisible(); await page.evaluate(() => { Object.assign(window,{hmrWitness:'same-page'}); }); writeFileSync(file,original.replace('About this sample','Updated by HMR')); await expect(page.getByRole('heading',{name:'Updated by HMR'})).toBeVisible(); expect(await page.evaluate(() => Reflect.get(window,'hmrWitness'))).toBe('same-page'); } finally { writeFileSync(file,original); } });\n",
      );
      try {
        await pnpm(['--filter', '@separate/web', 'test:e2e', '--', '--grep', 'isolated HMR'], {
          cwd: root,
        });
      } finally {
        rmSync(filename);
      }
    });
    await phase('warm-setup', async () => {
      await pnpm(['env:setup'], { cwd: root });
    });
    await phase('warm-gate', async () => {
      await pnpm(['gate:full'], { cwd: root });
    });
    for (const relative of [
      '.state',
      '.template-cache',
      'node_modules/.vite',
      'node_modules/.vite-plus',
    ])
      rmSync(path.join(root, relative), { recursive: true, force: true });
    await phase('cache-cleared-gate', async () => {
      await pnpm(['gate:full'], { cwd: root });
    });
    const readme = readFileSync(path.join(root, 'README.md'));
    writeFileSync(
      path.join(root, 'README.md'),
      `${readme.toString()}\nUser-owned documentation.\n`,
    );
    writeFileSync(path.join(root, 'USER.md'), 'Unrelated user content\n');
    cli([
      'init',
      '--name',
      options.name,
      '--scope',
      options.scope,
      '--preset',
      'web',
      '--no-install',
    ]);
    assert.ok(
      readFileSync(path.join(root, 'README.md'), 'utf8').includes('User-owned documentation.'),
    );
    const beforeCollision = contentId(root);
    cli(
      [
        'init',
        '--name',
        'different-identity',
        '--scope',
        '@different',
        '--preset',
        'api',
        '--no-install',
      ],
      /User change or collision/u,
    );
    assert.equal(contentId(root), beforeCollision);
    writeFileSync(path.join(root, 'README.md'), readme);
    await phase('rename-and-exclude', async () => {
      cli([
        'init',
        '--name',
        'different-identity',
        '--scope',
        '@different',
        '--preset',
        'api',
        '--no-install',
      ]);
      await pnpm(['env:setup'], { cwd: root });
      await pnpm(['env:doctor'], { cwd: root });
      for (const name of ['web', 'ui', 'desktop'])
        assert.equal(existsSync(path.join(root, `packages/${name}/package.json`)), false);
      assert.deepEqual(
        workspacePackages(root)
          .map((pkg) => pkg.name)
          .sort(),
        ['@different/api', '@different/contracts'],
      );
      assert.equal(readFileSync(path.join(root, 'USER.md'), 'utf8'), 'Unrelated user content\n');
      await pnpm(['gate:full'], { cwd: root });
    });
    await phase('add-and-start', async () => {
      const before = contentId(root);
      cli(['add', '--kind', 'api', '--name', 'api', '--no-install'], /App already exists/u);
      assert.equal(contentId(root), before);
      cli(['add', '--kind', 'api', '--name', 'jobs', '--features', 'kv', '--no-install']);
      await pnpm(['env:setup'], { cwd: root });
      await pnpm(['env:doctor'], { cwd: root });
      await pnpm(['gate:full'], { cwd: root });
      const servers = new Servers(root);
      try {
        const origin = await servers.workers('jobs');
        assert.equal((await fetch(`${origin}/health`)).status, 200);
      } finally {
        await servers.stop();
      }
    });
    await phase('sample-removal', async () => {
      for (const pkg of workspacePackages(root).filter((pkg) => pkg.runtime === 'worker')) {
        rmSync(path.join(root, pkg.directory, 'src/notes.ts'));
        for (const filename of ['unit.test.ts', 'runtime.test.ts'])
          rmSync(path.join(root, pkg.directory, 'test', filename));
        writeFileSync(
          path.join(root, pkg.directory, 'src/index.ts'),
          "export default { fetch(request: Request): Response { return Response.json({ value: new URL(request.url).pathname === '/health' ? 'ready' : 'custom application' }); } };\n",
        );
        writeFileSync(
          path.join(root, pkg.directory, 'test/custom.test.ts'),
          "import { expect, it } from 'vitest';\nimport worker from '../src/index.ts';\nit('implements the replacement application', async () => { expect(await worker.fetch(new Request('http://localhost/custom')).json()).toEqual({value:'custom application'}); });\n",
        );
        writeFileSync(
          path.join(root, pkg.directory, 'test/custom.runtime.test.ts'),
          "import { expect, it } from 'vitest';\nit('runs the replacement in real workerd', async () => { const origin=process.env.STARTER_TEST_ORIGIN; if(!origin) throw new Error('Use test:runtime'); expect(await (await fetch(new URL('/custom',origin))).json()).toEqual({value:'custom application'}); });\n",
        );
        const manifestPath = path.join(root, pkg.directory, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          dependencies: Record<string, string>;
        };
        manifest.dependencies = {};
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      rmSync(path.join(root, 'packages/contracts'), { recursive: true });
      await pnpm(['install', '--no-frozen-lockfile'], { cwd: root });
      await pnpm(['exec', 'vp', 'fmt'], { cwd: root });
      await pnpm(['env:setup'], { cwd: root });
      await pnpm(['gate:full'], { cwd: root });
      const pkg = workspacePackages(root).find((value) => value.name === '@different/jobs')!;
      assert.ok(pkg);
      const servers = new Servers(root);
      try {
        const origin = await servers.workers(pkg.name);
        assert.deepEqual(await (await fetch(`${origin}/custom`)).json(), {
          value: 'custom application',
        });
      } finally {
        await servers.stop();
      }
    });
    // The command itself, rather than a copied assertion, exercises journal recovery.
    await phase('interrupted-recovery', async () => {
      const previous = readFileSync(path.join(root, 'USER.md'));
      writeFileSync(path.join(root, 'USER.md'), 'completed generated write');
      const { digest } = await import('./files.ts');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          directories: [],
          files: [
            {
              path: 'USER.md',
              previous: previous.toString('base64'),
              next: digest('completed generated write'),
            },
          ],
        }),
      );
      await run(
        process.execPath,
        [
          'tools/generators/cli.ts',
          'init',
          '--recover',
          '--name',
          'different-identity',
          '--scope',
          '@different',
          '--preset',
          'api',
          '--no-install',
        ],
        { cwd: root },
      );
      assert.equal(readFileSync(path.join(root, 'USER.md'), 'utf8'), previous.toString());
      await pnpm(['gate:full'], { cwd: root });
    });
    await phase('re-add-excluded-web', async () => {
      const userFile = path.join(root, 'packages/ui/USER.md');
      mkdirSync(path.dirname(userFile), { recursive: true });
      writeFileSync(userFile, 'Protected library directory content\n');
      cli(['add', '--kind', 'web', '--name', 'portal', '--no-install'], /contains user files/u);
      assert.equal(readFileSync(userFile, 'utf8'), 'Protected library directory content\n');
      rmSync(userFile);
      cli(['add', '--kind', 'web', '--name', 'portal', '--no-install']);
      await pnpm(['env:setup'], { cwd: root });
      await pnpm(['env:doctor'], { cwd: root });
      await pnpm(['gate:full'], { cwd: root });
    });
    assert.deepEqual(reports.map((entry) => entry.id).toSorted(), lifecyclePhases.toSorted());
    completed = true;
  } finally {
    mkdirSync(path.join(source, 'artifacts'), { recursive: true });
    writeFileSync(
      path.join(source, 'artifacts/lifecycle.json'),
      `${JSON.stringify({ schema: 1, baselineDifferences: baselineDifferences(source), contentId: contentId(source), os: process.platform, status: completed && reports.length && reports.every((entry) => entry.status === 'passed') ? 'passed' : 'failed', origin: (JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8')) as { origin?: unknown }).origin, reports }, null, 2)}\n`,
    );
    rmSync(owned, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith(`${path.sep}lifecycle.ts`)) await lifecycleRehearsal(process.cwd());
