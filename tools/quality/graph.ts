import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type WorkspacePackage = {
  name: string;
  directory: string;
  runtime: 'library' | 'worker' | 'desktop';
  dependencies: string[];
  scripts: Record<string, string>;
};

export function workspacePackages(root: string): WorkspacePackage[] {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(packages, entry.name, 'package.json')),
    )
    .map((entry) => {
      const directory = `packages/${entry.name}`;
      const manifest = JSON.parse(
        readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
      ) as {
        name: string;
        starter?: { runtime?: WorkspacePackage['runtime'] };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      return {
        name: manifest.name,
        directory,
        runtime: manifest.starter?.runtime ?? 'library',
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
        }),
        scripts: manifest.scripts ?? {},
      };
    });
}

export function affectedPackages(
  packages: WorkspacePackage[],
  changed: readonly string[] | undefined,
): WorkspacePackage[] {
  if (changed === undefined) return packages;
  const selected = new Set<string>();
  for (const filename of changed) {
    if (!filename.startsWith('packages/')) return packages;
    const owner = packages.find(
      (pkg) => filename === pkg.directory || filename.startsWith(`${pkg.directory}/`),
    );
    // A removed or unrecognised package can still have consumers in the base.
    if (!owner) return packages;
    selected.add(owner.name);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const pkg of packages) {
      if (!selected.has(pkg.name) && pkg.dependencies.some((name) => selected.has(name))) {
        selected.add(pkg.name);
        expanded = true;
      }
    }
  }
  return packages.filter((pkg) => selected.has(pkg.name));
}
