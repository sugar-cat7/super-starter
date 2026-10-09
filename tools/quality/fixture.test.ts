import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { copyProjectFixture } from './fixture.ts';

it('rehearses the complete first-party input when legal apps and source resemble SDK outputs', () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'rehearsal-input-'));
  const source = path.join(owned, 'source');
  const destination = path.join(owned, 'copy');
  const put = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), contents);
  };
  try {
    for (const name of ['dist', 'target', 'generated', 'icons', 'gen', 'artifacts']) {
      put(
        `packages/${name}/package.json`,
        JSON.stringify({ name: `@example/${name}`, starter: { runtime: 'desktop' } }),
      );
      for (const directory of ['target', 'dist', 'generated', 'icons', 'gen', 'artifacts'])
        put(`packages/${name}/src/${directory}/user.ts`, `export const value = '${name}';`);
      put(`packages/${name}/dist/bundle.js`, 'generated output');
      put(`packages/${name}/src-tauri/target/binary`, 'native output');
      put(`packages/${name}/.env.local`, 'local credential');
    }
    put('tools/generated/user.ts', 'first-party tooling');
    put('.env', 'local credential');
    copyProjectFixture(source, destination);
    for (const name of ['dist', 'target', 'generated', 'icons', 'gen', 'artifacts']) {
      expect(existsSync(path.join(destination, `packages/${name}/package.json`))).toBe(true);
      for (const directory of ['target', 'dist', 'generated', 'icons', 'gen', 'artifacts'])
        expect(
          readFileSync(path.join(destination, `packages/${name}/src/${directory}/user.ts`), 'utf8'),
        ).toBe(`export const value = '${name}';`);
      expect(existsSync(path.join(destination, `packages/${name}/dist`))).toBe(false);
      expect(existsSync(path.join(destination, `packages/${name}/src-tauri/target`))).toBe(false);
      expect(existsSync(path.join(destination, `packages/${name}/.env.local`))).toBe(false);
    }
    expect(readFileSync(path.join(destination, 'tools/generated/user.ts'), 'utf8')).toBe(
      'first-party tooling',
    );
    expect(existsSync(path.join(destination, '.env'))).toBe(false);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
