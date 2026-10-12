import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInput, expected } from './web-agent-input.mjs';

const input = await assertInput();
const directory = path.resolve('artifacts/agent-web-api');
const file = path.join(directory, 'commands.json');
const commands = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const phases = [
  'setup',
  'doctor',
  'dev',
  'targeted-test',
  'pre-pr',
  'full',
  'ci',
  'build',
  'preflight',
];
const inputValid = (identity) =>
  identity &&
  identity.featureSha === input.featureSha &&
  identity.contentId === input.contentId &&
  identity.origin.sha === expected.originSha &&
  identity.origin.contentId === expected.originContentId &&
  identity.origin.dirty === false &&
  identity.clean;
const logValid = (relative) => {
  if (!relative.startsWith('logs/') || !relative.endsWith('.log')) return false;
  const log = path.resolve(directory, relative);
  return (
    existsSync(log) &&
    realpathSync(log).startsWith(`${realpathSync(path.join(directory, 'logs'))}${path.sep}`) &&
    statSync(log).size > 0
  );
};
const { agentCommandValid } = await import(
  pathToFileURL(path.resolve('tools/quality/acceptance.ts')).href
);
const commandValid = (entry) =>
  entry.exit === 0 &&
  !entry.inputGuardError &&
  inputValid(entry.inputBefore) &&
  inputValid(entry.inputAfter) &&
  logValid(entry.log) &&
  (entry.phase === 'ci'
    ? JSON.stringify(entry.argv) ===
      JSON.stringify([
        'pnpm',
        'gate:ci',
        '--',
        '--base',
        expected.baseSha,
        '--checks',
        'javascript',
      ])
    : agentCommandValid(entry.phase, entry.argv));
const { globalChecks, packageChecks } = await import(
  pathToFileURL(path.resolve('tools/quality/definitions.ts')).href
);
const { workspacePackages } = await import(
  pathToFileURL(path.resolve('tools/quality/graph.ts')).href
);
const expectedFull = [
  ...globalChecks,
  ...workspacePackages(process.cwd()).flatMap((pkg) => packageChecks(pkg, 'full')),
];
const gateValid = (mode) => {
  const variant = mode === 'ci' ? 'javascript' : 'all';
  const file = `artifacts/gate-${mode}-${variant}-linux.json`;
  if (!existsSync(file)) return false;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  return (
    report.sha === expected.featureSha &&
    report.contentId === expected.contentId &&
    report.origin.sha === expected.originSha &&
    report.origin.contentId === expected.originContentId &&
    report.origin.dirty === false &&
    report.status === 'passed' &&
    report.variant === variant &&
    report.checks.length > 0 &&
    report.checks.every((check) => check.status === 'passed') &&
    (mode === 'full'
      ? report.checks.length === expectedFull.length &&
        expectedFull.every((check) =>
          report.checks.some(
            (actual) =>
              actual.id === check.id &&
              JSON.stringify(actual.command) === JSON.stringify(check.command),
          ),
        )
      : report.base === expected.baseSha)
  );
};
const identitiesValid = ['before-setup', 'after-setup', 'after-execution'].every((phase) => {
  const file = path.join(directory, `input-${phase}.json`);
  return existsSync(file) && inputValid(JSON.parse(readFileSync(file, 'utf8')));
});
const gates = Object.fromEntries(['pre-pr', 'full', 'ci'].map((mode) => [mode, gateValid(mode)]));
const requiredCommands = [
  ['pnpm', 'env:setup'],
  ['pnpm', 'env:doctor'],
  ['pnpm', 'dev', '--', 'web'],
  ['pnpm', '--filter', '@independent-web/api', 'test'],
  ['pnpm', '--filter', '@independent-web/web', 'test'],
  ['pnpm', 'gate:pre-pr', '--', '--base', expected.baseSha],
  ['pnpm', 'gate:full'],
  ['pnpm', 'gate:ci', '--', '--base', expected.baseSha, '--checks', 'javascript'],
  ['pnpm', 'build'],
  ['pnpm', 'deploy:preflight', '--', '--target', 'api', '--environment', 'local'],
  ['pnpm', 'deploy:preflight', '--', '--target', 'web', '--environment', 'local'],
];
const commandsComplete =
  requiredCommands.every((argv) =>
    commands.some(
      (entry) => JSON.stringify(entry.argv) === JSON.stringify(argv) && commandValid(entry),
    ),
  ) &&
  commands.every(
    (entry) =>
      entry.exit === 0 &&
      !entry.inputGuardError &&
      inputValid(entry.inputBefore) &&
      inputValid(entry.inputAfter) &&
      logValid(entry.log),
  );
const passed =
  phases.every((phase) => commands.some((entry) => entry.phase === phase && commandValid(entry))) &&
  commandsComplete &&
  Object.values(gates).every(Boolean) &&
  identitiesValid;
const { toolVersions, artifactSizes } = await import(
  pathToFileURL(path.resolve('tools/quality/evidence.ts')).href
);
const report = {
  schema: 1,
  execution: 'hosted-tools',
  status: passed ? 'passed' : 'blocked',
  ...input,
  kind: 'hosted-web-api-support',
  scope:
    'Mechanical hosted validation of the immutable independently authored feature; this script does not produce Agent acceptance or claim Git commit/push evidence.',
  requiredSupportPhases: phases,
  requiredCommands,
  commandsComplete,
  commands,
  gates,
  identitiesValid,
  versions: toolVersions(process.cwd()),
  artifacts: artifactSizes(process.cwd()),
};
writeFileSync(
  path.join(directory, 'hosted-web-api-support.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    status: report.status,
    featureSha: input.featureSha,
    contentId: input.contentId,
    supportSha: input.supportSha,
    gates,
  }),
);
if (!passed) process.exitCode = 1;
