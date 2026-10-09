import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Files } from './files.ts';
import { digest, applyFiles } from './files.ts';
import type { TemplateState } from './render.ts';
import { safeFile } from './safety.ts';

const formatted = new Map<string, Buffer>();
export function formatterKey(root: string): string | undefined {
  const manifest = path.join(root, 'node_modules/vite-plus/package.json');
  if (!existsSync(manifest)) return undefined;
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
  return digest(`${version}\0${readFileSync(path.join(root, 'vite.config.ts'), 'utf8')}`);
}

// Rendering delegates layout to the pinned, project-local formatter, never a second formatter.
// Cold bootstrap renders without dependencies; setup finalizes only unchanged managed files.
export function formatFiles(root: string, files: Files): Files {
  const binary = path.join(root, 'node_modules/vite-plus/bin/vp');
  if (!existsSync(binary)) return files;
  const formatter = formatterKey(root);
  for (const [filename, contents] of files) {
    if (!/\.(?:[cm]?[jt]sx?|json|css|html)$/u.test(filename)) continue;
    const key = digest(Buffer.concat([Buffer.from(`${formatter}\0${filename}\0`), contents]));
    const cached = formatted.get(key);
    if (cached) {
      files.set(filename, cached);
      continue;
    }
    const result = spawnSync(process.execPath, [binary, 'fmt', '--stdin-filepath', filename], {
      cwd: root,
      input: contents,
      timeout: 30_000,
      maxBuffer: 5_000_000,
    });
    if (result.status !== 0)
      throw new Error(`Generated format failed for ${filename}: ${result.stderr.toString()}`);
    files.set(filename, result.stdout);
    formatted.set(key, result.stdout);
  }
  return files;
}

export function finalizeManaged(root: string): void {
  const statePath = path.join(root, '.template.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as TemplateState;
  const key = formatterKey(root);
  if (key && state.formatKey === key) return;
  const original = readFileSync(statePath);
  const observed = new Map<string, string>();
  const files: Files = new Map();
  for (const [filename, hash] of Object.entries(state.managed)) {
    const target = safeFile(root, filename);
    if (existsSync(target) && digest(readFileSync(target)) === hash) {
      files.set(filename, readFileSync(target));
      observed.set(filename, hash);
    }
  }
  formatFiles(root, files);
  for (const [filename, contents] of files) {
    state.managed[filename] = digest(contents);
  }
  if (key) state.formatKey = key;
  files.set('.template.json', Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  observed.set('.template.json', digest(original));
  const entries = [...files.keys()];
  const unchanged = (filename: string): void => {
    if (
      !existsSync(safeFile(root, filename)) ||
      digest(readFileSync(safeFile(root, filename))) !== observed.get(filename)
    )
      throw new Error(
        `User edited during formatting: ${filename}; nothing will be silently overwritten`,
      );
  };
  entries.forEach(unchanged);
  applyFiles(root, files, [], (index) => unchanged(entries[index]!));
}
