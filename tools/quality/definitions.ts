import type { WorkspacePackage } from './graph.ts';

export type Check = {
  id: string;
  requirements: string[];
  package?: string;
  command: string[];
  timeout: number;
  reason: string;
};
export const globalChecks: Check[] = [
  {
    id: 'static',
    requirements: ['layout', 'quality', 'boundaries', 'docs', 'secrets'],
    command: ['check'],
    timeout: 180_000,
    reason: 'Repository-wide static checks are lightweight and run once',
  },
  {
    id: 'tools-unit',
    requirements: ['generator-safety', 'affected', 'failure-propagation'],
    command: ['test:tools'],
    timeout: 180_000,
    reason: 'Shared tooling contracts',
  },
];

export function packageChecks(pkg: WorkspacePackage, phase: 'test' | 'build' | 'full'): Check[] {
  const entries: [string, string, string[]][] =
    phase === 'build'
      ? [['build', 'build', ['build']]]
      : [['unit', 'test', ['contracts', 'ui-states']]];
  if (phase === 'full') {
    entries.push(['build', 'build', ['build']]);
    if (pkg.runtime === 'worker')
      entries.push(['runtime', 'test:runtime', ['worker', 'bindings', 'environments']]);
    if (pkg.scripts['test:restart'])
      entries.push(['restart', 'test:restart', ['migration', 'seed', 'persistence']]);
    if (pkg.scripts['test:e2e'])
      entries.push(['browser', 'test:e2e', ['web', 'accessibility', 'vrt']]);
    if (pkg.runtime === 'desktop')
      entries.push(
        ['rust', 'test:rust', ['rust', 'ipc', 'export']],
        ['native', 'test:native', ['native-three-os', 'ipc']],
        ['release', 'test:release', ['release-isolation']],
      );
  }
  return entries.map(([id, script, requirements]) => ({
    id: `${pkg.name}/${id}`,
    requirements,
    package: pkg.name,
    command: ['--filter', pkg.name, script],
    timeout: pkg.runtime === 'desktop' && id !== 'unit' ? 30 * 60_000 : 180_000,
    reason: `Selected ${pkg.runtime} ${pkg.name}; ${phase} phase`,
  }));
}
