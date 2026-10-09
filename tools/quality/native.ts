import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { availablePort, stopTree } from '../dev-environment/servers.ts';
import { pnpm, run } from '../process.ts';

const cwd = process.cwd();
const root = path.resolve(cwd, '../..');
const native = path.join(cwd, 'src-tauri');
const cargo = readFileSync(path.join(native, 'Cargo.toml'), 'utf8');
const name = /^name = "([^"]+)"/mu.exec(cargo)?.[1];
if (!name) throw new Error('Cargo package name missing');
const operation = process.argv[2];
const target = path.join(
  root,
  '.state',
  path.basename(cwd),
  `target-${operation === 'e2e' ? 'e2e' : 'release'}`,
);
const binary = path.join(target, 'release', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const environment = { ...process.env, CARGO_TARGET_DIR: target };
if (
  process.platform === 'linux' &&
  ['e2e', 'release'].includes(operation ?? '') &&
  !process.env.DISPLAY
)
  throw new Error(
    'Native Linux validation requires a real display (CI uses Xvfb); renderer-only tests are separate',
  );
if (operation === 'rust') {
  await run('cargo', ['fmt', '--', '--check'], { cwd: native });
  await run('cargo', ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'], {
    cwd: native,
    env: environment,
    timeout: 30 * 60_000,
  });
  await run('cargo', ['test', '--locked'], { cwd: native, env: environment, timeout: 30 * 60_000 });
} else if (operation === 'e2e') {
  await pnpm(
    [
      'exec',
      'tauri',
      'build',
      '--no-bundle',
      '--features',
      'e2e',
      '--config',
      'src-tauri/tauri.e2e.conf.json',
      '--config',
      JSON.stringify({ build: { beforeBuildCommand: 'pnpm build:renderer --mode e2e' } }),
    ],
    { cwd, env: environment, timeout: 30 * 60_000 },
  );
  const owned = path.join(root, 'artifacts', `native-${process.platform}`);
  mkdirSync(owned, { recursive: true });
  for (const scenario of ['save', 'cancel', 'error']) {
    const savePath =
      scenario === 'cancel'
        ? 'cancel'
        : scenario === 'error'
          ? path.join(owned, 'missing', 'notes.json')
          : path.join(owned, 'notes.json');
    await pnpm(['exec', 'wdio', 'run', 'wdio.conf.ts'], {
      cwd,
      timeout: 180_000,
      env: {
        ...environment,
        STARTER_NATIVE_BINARY: binary,
        STARTER_DRIVER_PORT: String(await availablePort()),
        STARTER_TEST_SAVE_PATH: savePath,
        STARTER_EXPORT_CASE: scenario,
      },
    });
  }
} else if (operation === 'build') {
  await pnpm(['exec', 'tauri', 'build', '--no-bundle'], {
    cwd,
    env: environment,
    timeout: 30 * 60_000,
  });
} else if (operation === 'release') {
  // Separate target and renderer mode prevent reusing feature-enabled artifacts.
  await pnpm(['exec', 'tauri', 'build', '--no-bundle'], {
    cwd,
    env: environment,
    timeout: 30 * 60_000,
  });
  const tree = await new Promise<string>((resolve, reject) => {
    const child = spawn('cargo', ['tree', '--locked', '-e', 'normal'], {
      cwd: native,
      env: environment,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error('Cargo release graph failed')),
    );
  });
  if (tree.includes('tauri-plugin-wdio'))
    throw new Error('WebDriver dependency leaked into release graph');
  const config = JSON.parse(readFileSync(path.join(native, 'tauri.conf.json'), 'utf8')) as {
    app: { withGlobalTauri: boolean; security: { capabilities: unknown[] } };
  };
  if (
    config.app.withGlobalTauri ||
    JSON.stringify(config.app.security.capabilities).includes('wdio')
  )
    throw new Error('WebDriver permission leaked into release config');
  const assets = path.join(cwd, 'dist/assets');
  const { walk } = await import('../generators/files.ts');
  for (const filename of walk(assets).filter((value) => value.endsWith('.js')))
    if (/__wdio|wdio:|plugin:wdio/u.test(readFileSync(path.join(assets, filename), 'utf8')))
      throw new Error('WebDriver frontend leaked into release bundle');
  const port = await availablePort();
  const child = spawn(binary, [], {
    cwd,
    env: { ...environment, TAURI_WEBDRIVER_PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const start = performance.now();
    while (!output.includes('NATIVE_READY') && performance.now() - start < 30_000) {
      if (child.exitCode !== null) throw new Error(`Release exited before startup: ${output}`);
      await pause(100);
    }
    if (!output.includes('NATIVE_READY'))
      throw new Error(`Release native startup timeout: ${output}`);
    await pause(1_000);
    if (child.exitCode !== null) throw new Error(`Release crashed after startup: ${output}`);
    let reachable = false;
    try {
      await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_000) });
      reachable = true;
    } catch {
      /* Feature-off release must have no driver listener. */
    }
    if (reachable) throw new Error('WebDriver server enabled in release');
    console.log(`Release native startup passed on ${process.platform}; WebDriver disabled`);
  } finally {
    await stopTree(child);
  }
} else throw new Error('Expected rust|e2e|release|build');
// Cleanup is limited to our test export; caches remain owned by this worktree.
if (
  operation === 'e2e' &&
  existsSync(path.join(root, 'artifacts', `native-${process.platform}`, 'notes.json'))
)
  rmSync(path.join(root, 'artifacts', `native-${process.platform}`, 'notes.json'));
