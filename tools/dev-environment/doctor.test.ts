import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { doctor } from './doctor.ts';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

beforeEach(() => {
  vi.mocked(spawnSync).mockImplementation((command) => {
    const stdout = command === 'rustc' ? 'rustc 1.99.0 (fixture)' : '12.10.1';
    return { status: command === 'git' ? 1 : 0, stdout, stderr: '' } as ReturnType<
      typeof spawnSync
    >;
  });
});

function fixture(inspect: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'doctor-pins-'));
  try {
    mkdirSync(path.join(root, 'packages/desktop/src-tauri'), { recursive: true });
    writeFileSync(
      path.join(root, 'mise.toml'),
      `[tools]\nnode = "${process.versions.node}"\n"aqua:pnpm/pnpm" = "12.10.1"\n`,
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@12.10.1' }),
    );
    writeFileSync(
      path.join(root, 'packages/desktop/package.json'),
      JSON.stringify({ name: '@example/desktop', starter: { runtime: 'desktop' } }),
    );
    writeFileSync(
      path.join(root, 'packages/desktop/src-tauri/rust-toolchain.toml'),
      '[toolchain]\nchannel = "1.99.0"\n',
    );
    inspect(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('environment versions', () => {
  it('accepts TOML quote/comment/spacing variants and ignores pins in other tables', () => {
    fixture((root) => {
      writeFileSync(
        path.join(root, 'mise.toml'),
        `[env]\nnode = "0.0.0"\n[tools] # selected preparation\nnode='${process.versions.node}' # LTS\n'aqua:pnpm/pnpm'="12.10.1"\n`,
      );
      writeFileSync(
        path.join(root, 'packages/desktop/src-tauri/rust-toolchain.toml'),
        "[other]\nchannel = '0.0.0'\n[toolchain]\nchannel='1.99.0' # pinned compiler\n",
      );
      for (const id of ['node', 'pnpm', '@example/desktop/rust'])
        expect(doctor(root).find((check) => check.id === id)?.ok).toBe(true);
    });
  });
  it('reads the selected versions from their owning manifests and never installs Rust', () => {
    fixture((root) => {
      const checks = doctor(root);
      for (const id of ['node', 'pnpm', '@example/desktop/rust'])
        expect(checks.find((check) => check.id === id)?.ok).toBe(true);
      expect(
        vi.mocked(spawnSync).mock.calls.find(([command]) => command === 'rustc')?.[2],
      ).toMatchObject({
        env: { RUSTUP_AUTO_INSTALL: '0' },
      });
    });
  });

  it('rejects version drift in Node, pnpm preparation and the package-local Rust pin', () => {
    fixture((root) => {
      writeFileSync(
        path.join(root, 'mise.toml'),
        '[tools]\nnode = "0.0.0"\n"aqua:pnpm/pnpm" = "12.10.0"\n',
      );
      writeFileSync(
        path.join(root, 'packages/desktop/src-tauri/rust-toolchain.toml'),
        '[toolchain]\nchannel = "1.98.1"\n',
      );
      const checks = doctor(root);
      for (const id of ['node', 'pnpm', '@example/desktop/rust'])
        expect(checks.find((check) => check.id === id)?.ok).toBe(false);
    });
  });

  it('fails closed when the preparation version is not an exact pin', () => {
    fixture((root) => {
      writeFileSync(
        path.join(root, 'mise.toml'),
        '[tools]\nnode = "latest"\n"aqua:pnpm/pnpm" = "12.10.1"\n',
      );
      expect(() => doctor(root)).toThrow(
        'Exact Node/aqua pnpm/packageManager versions are required',
      );
    });
  });
});
