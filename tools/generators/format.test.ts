import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { formatFiles } from './format.ts';

const source = path.resolve(import.meta.dirname, '../..');
function fixture(config: string, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-format-'));
  try {
    symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'vite.config.ts'), config);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const simple =
  'export default { fmt: { singleQuote: true, ignorePatterns: ["packages/cache/dist/**"] } };';
function cli(root: string, filename: string, contents: Buffer): Buffer {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/vite-plus/bin/vp'), 'fmt', '--stdin-filepath', filename],
    { cwd: root, input: contents, timeout: 30_000 },
  );
  expect({ status: result.status, stderr: result.stderr.toString() }).toEqual({
    status: 0,
    stderr: '',
  });
  return result.stdout;
}

it('matches the owning SDK CLI for mixed scripts, ignored build output and JSON', () => {
  fixture(simple, (root) => {
    const files = new Map([
      ['packages/cache/src/example.ts', Buffer.from('export const value="quoted";')],
      ['packages/cache/src/view.tsx', Buffer.from('export const view=<button>go</button>;')],
      ['packages/cache/dist/ignored.ts', Buffer.from('export const untouched= [1,2];')],
      ['package.json', Buffer.from('{"name":"parity","type":"module"}')],
    ]);
    const expected = new Map(
      [...files].map(([name, contents]) => [name, cli(root, name, contents)]),
    );
    expect(formatFiles(root, files)).toEqual(expected);
    expect(files.get('packages/cache/src/example.ts')?.toString()).toContain("'quoted'");
    expect(files.get('packages/cache/dist/ignored.ts')?.toString()).toBe(
      'export const untouched= [1,2];',
    );
  });
});

it.each([
  [
    'custom formatter option',
    'export default { fmt: { singleQuote: false, semi: false, ignorePatterns: [] } };',
    false,
  ],
  ['editorconfig', simple, true],
])('retains CLI semantics with %s', (_, config, editorconfig) => {
  fixture(config, (root) => {
    if (editorconfig)
      writeFileSync(
        path.join(root, '.editorconfig'),
        'root = true\n[*]\nindent_style = space\nindent_size = 4\n',
      );
    const filename = `fallback-${editorconfig ? 'editor' : 'options'}.ts`;
    const contents = Buffer.from('export function fallback(){return "value";}');
    const expected = cli(root, filename, contents);
    expect(formatFiles(root, new Map([[filename, contents]])).get(filename)).toEqual(expected);
    expect(expected.toString().includes(';')).toBe(editorconfig);
    expect(readFileSync(path.join(root, 'vite.config.ts'), 'utf8')).toBe(config);
  });
});

it('rejects a malformed script before installing any batch output', () => {
  fixture(simple, (root) => {
    const files = new Map([
      ['atomic-valid.ts', Buffer.from('export const atomicValid="value";')],
      ['atomic-invalid.ts', Buffer.from('export const = ;')],
    ]);
    const original = new Map(files);
    expect(() => formatFiles(root, files)).toThrow('Generated batch format failed');
    expect(files).toEqual(original);
  });
});

it('invalidates cached formatting across roots and after a side configuration change', () => {
  fixture(simple, (first) => {
    const filename = 'cache-protection.ts';
    const contents = Buffer.from('export function cacheProtection(){return "value";}');
    const format = (root: string) =>
      formatFiles(root, new Map([[filename, contents]])).get(filename)!;
    const before = format(first);
    expect(before.toString()).toContain("\n  return 'value';");
    const editorconfig = 'root = true\n[*]\nindent_style = space\nindent_size = 4\n';
    fixture(simple, (second) => {
      writeFileSync(path.join(second, '.editorconfig'), editorconfig);
      expect(format(second)).toEqual(cli(second, filename, contents));
      expect(format(second).toString()).toContain("\n    return 'value';");
    });
    writeFileSync(path.join(first, '.editorconfig'), editorconfig);
    expect(format(first)).toEqual(cli(first, filename, contents));
    expect(format(first)).not.toEqual(before);
  });
});

it('matches CLI stdin behavior for a gitignored source file and CLI runtime metadata', () => {
  fixture(
    'export default {fmt:{singleQuote:process.env.JS_RUNTIME_VERSION === process.versions.node && process.env.JS_RUNTIME_NAME === process.release.name && process.env.NODE_PACKAGE_MANAGER === "vite-plus",ignorePatterns:[]}};',
    (root) => {
      writeFileSync(path.join(root, '.gitignore'), 'gitignored.ts\n');
      const contents = Buffer.from('export const metadata="value";');
      const output = formatFiles(root, new Map([['gitignored.ts', contents]])).get('gitignored.ts');
      expect(output).toEqual(cli(root, 'gitignored.ts', contents));
      expect(output?.toString()).toContain("'value'");
    },
  );
});
