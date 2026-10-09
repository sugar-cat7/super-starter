import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { digest } from './files.ts';
import { baselineDifferences } from './baseline.ts';

it('distinguishes an unchanged generated baseline from feature edits and extra source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-baseline-'));
  try {
    const files = {
      'packages/example/package.json': JSON.stringify({
        name: '@scope/example',
        starter: { runtime: 'library' },
      }),
      'packages/example/src/index.ts': 'export const value=1;',
      'pnpm-lock.yaml': 'lock',
    };
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        managed: Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name !== 'pnpm-lock.yaml')
            .map(([name, text]) => [name, digest(text)]),
        ),
        lockId: digest('lock'),
      }),
    );
    expect(baselineDifferences(root)).toEqual([]);
    writeFileSync(path.join(root, 'packages/example/src/index.ts'), 'export const value=2;');
    writeFileSync(path.join(root, 'packages/example/src/extra.test.ts'), 'feature regression');
    expect(baselineDifferences(root)).toEqual([
      'packages/example/src/extra.test.ts',
      'packages/example/src/index.ts',
    ]);
    expect(readFileSync(path.join(root, 'packages/example/src/index.ts'), 'utf8')).toContain(
      'value=2',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('inherits canonical provenance without Git only while the generated baseline is unchanged', async () => {
  const { generationOrigin } = await import('./render.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-origin-'));
  const sha = 'a'.repeat(40);
  try {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(
      path.join(root, '.template.json'),
      JSON.stringify({
        kind: 'project',
        managed: { 'package.json': digest('{}') },
        lockId: digest('lock'),
        origin: { sha, dirty: false },
      }),
    );
    expect(generationOrigin(root)).toEqual({ sha, dirty: false });
    rmSync(path.join(root, 'pnpm-lock.yaml'));
    expect(generationOrigin(root)).toEqual({ sha: null, dirty: true });
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(path.join(root, 'package.json'), 'feature');
    expect(generationOrigin(root)).toEqual({ sha: null, dirty: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('renders renamed Desktop locks in Cargo order without changing locked dependencies', async () => {
  const { appFiles } = await import('./render.ts');
  const { projectOptions } = await import('./options.ts');
  const source = path.resolve(import.meta.dirname, '../..');
  const blueprint = readFileSync(
    path.join(source, 'tools/generators/templates/desktop/src-tauri/Cargo.lock.template'),
    'utf8',
  );
  const blocks = (lock: string) =>
    lock
      .split('[[package]]\n')
      .slice(1)
      .map((block) => block.trimEnd());
  const dependencyBlocks = blocks(blueprint)
    .filter((block) => !block.includes('name = "__PROJECT__-__APP__"'))
    .sort();
  for (const name of ['aaa-notes', 'zzz-notes']) {
    const options = projectOptions({ name, scope: '@renamed', preset: 'desktop' });
    const lock = appFiles(source, options, 'desktop', 'desktop', false)
      .get('packages/desktop/src-tauri/Cargo.lock')!
      .toString();
    const packages = blocks(lock);
    const names = packages.map((block) => /^name = "([^"]+)"/mu.exec(block)![1]!);
    expect(names).toEqual([...names].sort());
    expect(packages.filter((block) => !block.includes(`name = "${name}-desktop"`)).sort()).toEqual(
      dependencyBlocks,
    );
  }
});

it('fingerprints legal app names and first-party directories that resemble generated caches', async () => {
  const { contentId } = await import('../quality/gate.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'generation-fingerprint-'));
  try {
    mkdirSync(path.join(root, 'packages/dist/src/target'), { recursive: true });
    mkdirSync(path.join(root, 'packages/dist/dist'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/dist/package.json'),
      JSON.stringify({ name: '@example/dist', starter: { runtime: 'library' } }),
    );
    const before = contentId(root);
    writeFileSync(path.join(root, 'packages/dist/src/target/user.ts'), 'source');
    const after = contentId(root);
    expect(after).not.toBe(before);
    writeFileSync(path.join(root, 'packages/dist/dist/generated.mjs'), 'build');
    expect(contentId(root)).toBe(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
