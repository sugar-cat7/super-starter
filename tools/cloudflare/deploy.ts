import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { flags } from '../generators/options.ts';
import { workspacePackages } from '../quality/graph.ts';
import { contentId } from '../quality/gate.ts';
import { pnpm } from '../process.ts';

const root = process.cwd();
const operation = process.argv[2];
if (operation !== 'preflight' && operation !== 'deploy')
  throw new Error('Expected preflight|deploy');
const input = flags(process.argv.slice(3));
if (!['local', 'dev', 'production'].includes(String(input.environment)))
  throw new Error('Explicit --environment local|dev|production is required');
const pkg = workspacePackages(root).find(
  (value) =>
    value.directory === input.target ||
    path.basename(value.directory) === input.target ||
    value.name === input.target,
);
if (!pkg || pkg.runtime !== 'worker')
  throw new Error('Explicit --target must identify a selected deployable Worker');
if (operation === 'deploy' && input.environment !== 'dev')
  throw new Error(
    'This entry deploys approved dev environments only; production requires a separate authorized workflow',
  );
const cwd = path.join(root, pkg.directory);
await pnpm(['check'], { cwd: root });
await pnpm(['--filter', pkg.name, 'test'], { cwd: root });
await pnpm(['--filter', pkg.name, 'test:runtime'], { cwd: root });
await pnpm(['--filter', pkg.name, 'build'], {
  cwd: root,
  env: {
    ...process.env,
    STARTER_BUILD_MODE: input.environment === 'local' ? 'offline' : String(input.environment),
  },
});
const config = JSON.parse(
  readFileSync(path.join(cwd, '.cloudflare/output/v0/workers/default/worker.config.json'), 'utf8'),
) as { env?: Record<string, { type: string; value?: string }> };
if (input.environment !== 'local' && config.env?.WRITE_MODE?.value !== 'deny')
  throw new Error('Remote artifact must deny unauthenticated writes');
if (input.environment !== 'local' && !process.env.CLOUDFLARE_ACCOUNT_ID)
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is missing. Configure a named approved dev account and resource IDs; see docs/cloudflare.md. No deployment occurred.',
  );
const record = {
  contentId: contentId(root),
  target: pkg.name,
  environment: input.environment,
  configSource: `${pkg.directory}/cloudflare.config.ts`,
  artifact: `${pkg.directory}/.cloudflare/output/v0`,
  deployed: false,
};
mkdirSync(path.join(root, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(root, 'artifacts/deploy-preflight.json'),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(JSON.stringify(record, null, 2));
if (operation === 'deploy') {
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error('CLOUDFLARE_API_TOKEN is missing; no deployment occurred');
  if (
    workspacePackages(root).some(
      (candidate) => candidate.runtime === 'worker' && pkg.dependencies.includes(candidate.name),
    )
  )
    throw new Error(
      'Deploy each upstream API first, smoke its approved dev environment, then deploy the Web target; see docs/cloudflare.md',
    );
  // Prebuilt output above corresponds to the successful checks. Never auto-provision resources.
  await pnpm(
    ['--filter', pkg.name, 'exec', 'cf', 'deploy', '--prebuilt', '--no-provision', '-m', 'dev'],
    { cwd: root },
  );
}
