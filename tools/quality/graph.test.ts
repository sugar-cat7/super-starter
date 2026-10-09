import { describe, expect, it } from 'vitest';
import { affectedPackages, type WorkspacePackage } from './graph.ts';

const pkg = (name: string, dependencies: string[] = []): WorkspacePackage => ({
  name,
  directory: `packages/${name}`,
  runtime: 'library',
  dependencies,
  scripts: {},
});
const graph = [
  pkg('contracts'),
  pkg('ui', ['contracts']),
  pkg('web', ['ui', 'contracts']),
  pkg('api', ['contracts']),
  pkg('desktop', ['ui']),
];

describe('affected workspace selection', () => {
  it('keeps an app-only change local', () => {
    expect(affectedPackages(graph, ['packages/api/src/index.ts']).map((p) => p.name)).toEqual([
      'api',
    ]);
  });
  it('expands reverse dependencies transitively', () => {
    expect(affectedPackages(graph, ['packages/ui/src/index.tsx']).map((p) => p.name)).toEqual([
      'ui',
      'web',
      'desktop',
    ]);
  });
  it('selects every consumer of a shared contract', () => {
    expect(affectedPackages(graph, ['packages/contracts/src/index.ts']).map((p) => p.name)).toEqual(
      graph.map((p) => p.name),
    );
  });
  it('selects all for root configuration, unknown base, deleted package and tooling', () => {
    for (const change of [
      undefined,
      ['pnpm-lock.yaml'],
      ['packages/removed/src/x.ts'],
      ['tools/quality/graph.ts'],
      ['vite.config.ts'],
    ]) {
      expect(affectedPackages(graph, change).map((p) => p.name)).toEqual(graph.map((p) => p.name));
    }
  });
  it('accounts for both paths of a rename', () => {
    expect(
      affectedPackages(graph, ['packages/web/src/old.ts', 'packages/api/src/new.ts']).map(
        (p) => p.name,
      ),
    ).toEqual(['web', 'api']);
  });
  it('does not invent app work for an empty diff', () => {
    expect(affectedPackages(graph, [])).toEqual([]);
  });
});
