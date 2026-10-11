import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwned, stopTree } from '../process.ts';
import { contentId } from '../quality/gate.ts';
import { headSha } from '../quality/checkout.ts';
import { securityChecks } from '../quality/definitions.ts';
import { workspacePackages } from '../quality/graph.ts';
import {
  semgrepReport,
  trivyReport,
  trivyDatabase,
  type Finding,
  type ScanResult,
} from './policy.ts';

export type SecurityReport = {
  schema: 1;
  sha: string | null;
  contentId: string;
  createdAt: string;
  status: 'passed' | 'failed';
  checks: {
    id: string;
    status: 'passed' | 'failed';
    milliseconds: number;
    reason?: string;
    result?: ScanResult;
  }[];
  findings: Finding[];
};
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const descriptor = openSync(log, 'wx', 0o600);
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      MISE_AUTO_INSTALL: 'false',
      SEMGREP_SEND_METRICS: 'off',
    };
    delete childEnv.SECURITY_REMEDIATION_TOKEN;
    return await new Promise<number>((resolve, reject) => {
      const child = spawnOwned(command, args, {
        cwd,
        stdio: ['ignore', descriptor, descriptor],
        env: childEnv,
      });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        void stopTree(child).catch(reject);
      }, timeout);
      child.once('error', (error) => {
        clearTimeout(timer);
        void stopTree(child).then(() => reject(error), reject);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        void stopTree(child).then(() => {
          if (expired || code === null) reject(new Error('Scanner terminated or timed out'));
          else resolve(code);
        }, reject);
      });
    });
  } finally {
    closeSync(descriptor);
  }
}
function expectedVersion(root: string, scanner: string): string {
  const profile = readFileSync(path.join(root, 'mise.security.toml'), 'utf8');
  const match =
    scanner === 'trivy'
      ? /"aqua:aquasecurity\/trivy"\s*=\s*"([\d.]+)"/u.exec(profile)
      : /"pypi:semgrep"\s*=\s*\{\s*version\s*=\s*"([\d.]+)"/u.exec(profile);
  if (!match?.[1]) throw new Error('Missing pinned scanner version');
  return match[1];
}
export async function scan(root: string, scanner?: string): Promise<SecurityReport> {
  if (scanner && !securityChecks.some((check) => check.id === scanner))
    throw new Error('Unknown scanner');
  const privateRoot = path.join(root, '.state/security');
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const output = path.join(root, 'artifacts/security/report.json');
  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const privateRun = mkdtempSync(path.join(privateRoot, 'scan-'));
  const before = contentId(root);
  const report: SecurityReport = {
    schema: 1,
    sha: headSha(root),
    contentId: before,
    createdAt: new Date().toISOString(),
    status: 'failed',
    checks: [],
    findings: [],
  };
  const locks = [
    'pnpm-lock.yaml',
    ...workspacePackages(root)
      .filter((pkg) => pkg.runtime === 'desktop')
      .map((pkg) => `${pkg.directory}/src-tauri/Cargo.lock`),
  ];
  for (const check of securityChecks.filter((entry) => !scanner || entry.id === scanner)) {
    const started = performance.now();
    const raw = path.join(privateRun, `${check.id}.json`);
    try {
      for (const lock of locks)
        if (!existsSync(path.join(root, lock))) throw new Error('Missing lockfile');
      const args =
        check.id === 'trivy'
          ? [
              'fs',
              '--scanners',
              'vuln,misconfig,secret',
              '--include-dev-deps',
              '--list-all-pkgs',
              '--format',
              'json',
              '--output',
              raw,
              '--ignorefile',
              '',
              '--disable-telemetry',
              '--timeout',
              '10m',
              ...[
                '.git',
                'node_modules',
                'artifacts',
                '.state',
                'generated',
                ...workspacePackages(root).flatMap((pkg) =>
                  [
                    'dist',
                    'artifacts',
                    'test-results',
                    '.cloudflare',
                    '.wrangler',
                    'src-tauri/target',
                    'src-tauri/gen',
                  ].map((suffix) => `${pkg.directory}/${suffix}`),
                ),
              ].flatMap((directory) => ['--skip-dirs', directory]),
              '.',
            ]
          : [
              'scan',
              '--config',
              'p/default',
              '--config',
              'tools/security/semgrep.yml',
              '--oss-only',
              '--metrics',
              'off',
              '--disable-version-check',
              '--disable-nosem',
              '--strict',
              '--severity',
              'ERROR',
              '--error',
              '--json',
              '--output',
              raw,
              ...[
                'node_modules',
                'artifacts',
                '.state',
                'dist',
                'target',
                'gen',
                '.cloudflare',
                '.wrangler',
              ].flatMap((directory) => ['--exclude', directory]),
              'packages',
              'tools',
              '.github',
            ];
      const code = await execute(
        'mise',
        ['--env', 'security', 'exec', '--', check.id, ...args],
        root,
        path.join(privateRun, `${check.id}.log`),
        check.timeout,
      );
      if (code !== 0 && !(check.id === 'semgrep' && code === 1))
        throw new Error('Scanner execution failed');
      const input: unknown = JSON.parse(readFileSync(raw, 'utf8'));
      const result = check.id === 'trivy' ? trivyReport(input, locks) : semgrepReport(input);
      if (result.version !== expectedVersion(root, check.id))
        throw new Error('Unexpected scanner version');
      if (check.id === 'trivy') {
        const metadata = path.join(privateRun, 'trivy-database.json');
        if (
          (await execute(
            'mise',
            ['--env', 'security', 'exec', '--', 'trivy', '--version', '--format', 'json'],
            root,
            metadata,
            30_000,
          )) !== 0
        )
          throw new Error('Database metadata unavailable');
        result.database = trivyDatabase(JSON.parse(readFileSync(metadata, 'utf8')) as unknown);
      }
      if (check.id === 'semgrep' && code === 1 && !result.findings.some((item) => item.blocking))
        throw new Error('Unexplained scanner failure');
      report.findings.push(...result.findings);
      report.checks.push({
        id: check.id,
        status: result.findings.some((item) => item.blocking) ? 'failed' : 'passed',
        milliseconds: Math.round(performance.now() - started),
        result,
      });
    } catch {
      // Raw logs stay private: failure text can contain source or credentials.
      report.checks.push({
        id: check.id,
        status: 'failed',
        milliseconds: Math.round(performance.now() - started),
        reason:
          'Execution, parsing, coverage or version failure; inspect private .state/security logs',
      });
    }
  }
  if (contentId(root) !== before)
    report.checks.push({
      id: 'source-integrity',
      status: 'failed',
      milliseconds: 0,
      reason: 'Source changed during read-only scan',
    });
  report.status =
    report.checks.length > 0 && report.checks.every((check) => check.status === 'passed')
      ? 'passed'
      : 'failed';
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length && (args.length !== 2 || args[0] !== '--scanner'))
    throw new Error('Expected --scanner trivy|semgrep');
  const report = await scan(process.cwd(), args[1]);
  console.log(
    `Security ${report.status}: ${report.findings.filter((item) => item.blocking).length} blocking findings; artifacts/security/report.json`,
  );
  if (report.status !== 'passed') process.exitCode = 1;
}
