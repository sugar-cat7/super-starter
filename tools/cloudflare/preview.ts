import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pnpm } from '../process.ts';

// cloudflare.config.ts -> SDK build output -> SDK Wrangler conversion.
// No authored second binding/environment configuration is maintained.
export async function preview(convert: (input: unknown) => unknown): Promise<void> {
  const cwd = process.cwd();
  const output = path.join(cwd, '.cloudflare/output/v0');
  const context = JSON.parse(readFileSync(path.join(output, 'config.json'), 'utf8')) as {
    buildContext?: { mode?: string };
  };
  if (context.buildContext?.mode !== 'offline')
    throw new Error('Local production preview needs an offline build; run pnpm build first');
  const { manifest, ...worker } = JSON.parse(
    readFileSync(path.join(output, 'workers/default/worker.config.json'), 'utf8'),
  ) as {
    manifest: { mainModule: string; modules: Record<string, { type: string }> };
    [key: string]: unknown;
  };
  if (
    !manifest ||
    !Object.keys(manifest.modules).length ||
    Object.values(manifest.modules).some((module) => module.type !== 'esm')
  )
    throw new Error(
      'Local preview requires the current ESM build manifest; review SDK compatibility before adopting other module formats',
    );
  const bundle = path.join(output, 'workers/default/bundle');
  for (const file of Object.keys(manifest.modules))
    if (
      !file.endsWith('.js') ||
      path.resolve(bundle, file).startsWith(`${bundle}${path.sep}`) === false ||
      !existsSync(path.join(bundle, file))
    )
      throw new Error(`Invalid or missing SDK-built module: ${file}`);
  if (!Object.hasOwn(manifest.modules, manifest.mainModule))
    throw new Error('SDK build manifest is missing its main module');
  const config = convert({ worker, containers: [] }) as {
    assets?: Record<string, unknown>;
    [key: string]: unknown;
  };
  config.main = path.join(bundle, manifest.mainModule);
  config.base_dir = bundle;
  config.find_additional_modules = true;
  config.rules = [{ type: 'ESModule', globs: Object.keys(manifest.modules), fallthrough: true }];
  const assets = path.join(output, 'workers/default/assets');
  if (existsSync(assets)) config.assets = { ...config.assets, directory: assets };
  const filename = path.join(cwd, '.cloudflare/preview.wrangler.json');
  writeFileSync(filename, `${JSON.stringify(config, null, 2)}\n`);
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await pnpm(
      [
        'exec',
        'wrangler',
        'dev',
        '--config',
        filename,
        '--no-bundle',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        process.env.STARTER_PORT ?? '8787',
        '--inspector-port',
        '0',
        '--persist-to',
        path.join(
          process.env.STARTER_STATE_ROOT ?? path.resolve(cwd, '../../.state'),
          path.basename(cwd),
        ),
      ],
      {
        cwd,
        timeout: 24 * 60 * 60_000,
        terminationGraceMs: 1_000,
        signal: cancellation.signal,
        env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' },
      },
    );
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
