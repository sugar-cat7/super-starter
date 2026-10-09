import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { safeFile } from './safety.ts';

export type Files = Map<string, Buffer>;
export const digest = (contents: Buffer | string): string =>
  createHash('sha256').update(contents).digest('hex');

export function walk(
  directory: string,
  prefix = '',
  ignored: ReadonlySet<string> = new Set(),
): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.has(entry.name) || ignored.has(relative)) return [];
      if (entry.isSymbolicLink())
        throw new Error(`Template must not contain symlinks: ${relative}`);
      return entry.isDirectory()
        ? walk(path.join(directory, entry.name), relative, ignored)
        : [relative];
    })
    .sort();
}

type Journal = {
  version: 1;
  files: { path: string; previous: string | null; next: string | null }[];
  directories: string[];
};
const journalName = '.template-transaction.json';

export function recover(root: string): void {
  const filename = safeFile(root, journalName);
  if (!existsSync(filename)) return;
  const journal = JSON.parse(readFileSync(filename, 'utf8')) as Journal;
  if (journal.version !== 1) throw new Error('Unknown template transaction version');
  for (const entry of journal.files) {
    const target = safeFile(root, entry.path);
    const current = existsSync(target) ? digest(readFileSync(target)) : null;
    const before = entry.previous === null ? null : digest(Buffer.from(entry.previous, 'base64'));
    if (current !== before && current !== entry.next)
      throw new Error(
        `Recovery found a user change: ${entry.path}; preserve it and review the transaction before retrying`,
      );
  }
  for (const directory of journal.directories) safeFile(root, directory);
  for (const entry of journal.files.toReversed()) {
    const target = safeFile(root, entry.path);
    if (entry.previous === null) rmSync(target, { force: true });
    else writeFileSync(target, Buffer.from(entry.previous, 'base64'));
  }
  for (const directory of journal.directories.toReversed()) {
    const target = safeFile(root, directory);
    if (existsSync(target) && readdirSync(target).length === 0) rmSync(target, { recursive: true });
  }
  rmSync(filename);
}

export function applyFiles(
  root: string,
  files: Files,
  remove: string[] = [],
  beforeWrite?: (index: number) => void,
): void {
  mkdirSync(root, { recursive: true });
  if (existsSync(safeFile(root, journalName)))
    throw new Error('Interrupted transaction found; rerun template:init with --recover');
  const targets = [...new Set([...files.keys(), ...remove])];
  if (new Set(targets.map((filename) => filename.toLowerCase())).size !== targets.length)
    throw new Error('Case-insensitive path collision');
  for (const filename of targets) {
    const target = safeFile(root, filename);
    if (existsSync(target) && !lstatSync(target).isFile())
      throw new Error(`Not a regular file: ${filename}`);
  }
  const directories = [
    ...new Set(
      [...files.keys()].flatMap((filename) => {
        const parts = filename.split('/').slice(0, -1);
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      }),
    ),
  ]
    .filter((relative) => !existsSync(safeFile(root, relative)))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const journal: Journal = {
    version: 1,
    files: targets.map((relative) => {
      const target = safeFile(root, relative);
      return {
        path: relative,
        previous: existsSync(target) ? readFileSync(target).toString('base64') : null,
        next: files.has(relative) ? digest(files.get(relative)!) : null,
      };
    }),
    directories,
  };
  writeFileSync(safeFile(root, journalName), `${JSON.stringify(journal)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    for (const directory of directories) mkdirSync(safeFile(root, directory), { recursive: true });
    let index = 0;
    for (const [relative, contents] of files) {
      beforeWrite?.(index++);
      writeFileSync(safeFile(root, relative), contents);
    }
    for (const relative of remove) rmSync(safeFile(root, relative));
    rmSync(safeFile(root, journalName));
  } catch (error) {
    recover(root);
    throw error;
  }
}
