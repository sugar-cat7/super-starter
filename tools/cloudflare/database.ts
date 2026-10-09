import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pnpm } from '../process.ts';

export async function database(
  cwd: string,
  action: 'migrate' | 'seed',
  stateRoot?: string,
): Promise<void> {
  const configPath = path.join(cwd, '.cloudflare/output/v0/workers/default/worker.config.json');
  if (!existsSync(configPath)) throw new Error('Build local configuration first: pnpm build');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    name: string;
    compatibilityDate: string;
    env?: Record<string, { type: string; id?: string }>;
  };
  const db = Object.values(config.env ?? {}).find((binding) => binding.type === 'd1');
  if (!db?.id)
    throw new Error('No selected D1 binding in the SDK-generated local build configuration');
  const persist = path.join(stateRoot ?? path.resolve(cwd, '../../.state'), path.basename(cwd));
  mkdirSync(persist, { recursive: true });
  // cf's current local SQL command did not terminate in compatibility testing.
  // Feed stable Wrangler a derived CLI-only config; cloudflare.config.ts stays the sole source.
  const derived = path.join(cwd, '.cloudflare', 'migration.wrangler.json');
  writeFileSync(
    derived,
    JSON.stringify({
      name: config.name,
      compatibility_date: config.compatibilityDate,
      main: './output/v0/workers/default/bundle/index.js',
      d1_databases: [
        {
          binding: 'DATABASE',
          database_id: db.id,
          database_name: db.id,
          migrations_dir: path.join(cwd, 'migrations'),
        },
      ],
    }),
  );
  const args =
    action === 'migrate'
      ? ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DATABASE']
      : ['exec', 'wrangler', 'd1', 'execute', 'DATABASE', '--file', path.join(cwd, 'seed.sql')];
  await pnpm([...args, '--config', derived, '--local', '--persist-to', persist], {
    cwd,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' },
    timeout: 120_000,
  });
}

export async function prepareDatabase(cwd: string, stateRoot?: string): Promise<void> {
  if (!existsSync(path.join(cwd, 'migrations'))) return;
  await database(cwd, 'migrate', stateRoot);
  const marker = path.join(
    stateRoot ?? path.resolve(cwd, '../../.state'),
    path.basename(cwd),
    '.seeded',
  );
  if (!existsSync(marker)) {
    await database(cwd, 'seed', stateRoot);
    writeFileSync(marker, '1\n');
  }
}

if (process.argv[1]?.endsWith(`${path.sep}database.ts`)) {
  const action = process.argv[2];
  if (action !== 'migrate' && action !== 'seed')
    throw new Error('Expected migrate|seed; remote SQL operations are not provided by this helper');
  await database(process.cwd(), action);
}
