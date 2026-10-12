import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { artifactSizes, toolVersions } from '../../tools/quality/evidence.ts';
import { globalChecks, packageChecks } from '../../tools/quality/definitions.ts';
import { workspacePackages } from '../../tools/quality/graph.ts';
import { assertExpectedInput } from './desktop-agent-input.ts';

const input = assertExpectedInput();
const directory = path.resolve('artifacts/agent-desktop');
const commands = JSON.parse(readFileSync(path.join(directory, 'commands.json'), 'utf8')) as {
  phase: string;
  argv: string[];
  exit: number;
  log: string;
  inputBefore?: typeof input;
  inputAfter?: typeof input;
}[];
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
const logValid = (relative: string) => {
  if (!relative.startsWith('logs/') || !relative.endsWith('.log')) return false;
  const file = path.resolve(directory, relative);
  return (
    existsSync(file) &&
    realpathSync(file).startsWith(`${realpathSync(path.join(directory, 'logs'))}${path.sep}`) &&
    statSync(file).size > 0
  );
};
const inputValid = (identity: typeof input | undefined) =>
  !!identity &&
  identity.featureSha === input.featureSha &&
  identity.contentId === input.contentId &&
  identity.origin.sha === input.origin.sha &&
  identity.origin.contentId === input.origin.contentId &&
  identity.origin.dirty === false &&
  identity.clean;
const commandValid = (command: (typeof commands)[number]) =>
  command.exit === 0 &&
  logValid(command.log) &&
  inputValid(command.inputBefore) &&
  inputValid(command.inputAfter) &&
  command.argv[0] === 'pnpm' &&
  !command.argv.some(
    (arg) => ['--no-verify', '--checks', '--dry-run'].includes(arg) || arg.startsWith('--checks='),
  ) &&
  command.argv.includes(
    (
      {
        setup: 'env:setup',
        doctor: 'env:doctor',
        dev: 'dev',
        'targeted-test': 'test',
        'pre-pr': 'gate:pre-pr',
        full: 'gate:full',
        ci: 'gate:ci',
        build: 'build',
        preflight: 'deploy:preflight',
      } as Record<string, string>
    )[command.phase] ?? '',
  );
const expectedChecks = [
  ...globalChecks,
  ...workspacePackages(process.cwd()).flatMap((pkg) => packageChecks(pkg, 'full')),
];
const gateValid = (mode: string) => {
  const file = `artifacts/gate-${mode}-all-${process.platform}.json`;
  if (!existsSync(file)) return false;
  const report = JSON.parse(readFileSync(file, 'utf8')) as {
    sha: string;
    contentId: string;
    variant: string;
    status: string;
    origin: typeof input.origin;
    checks: { id: string; status: string; command: string[] }[];
  };
  return (
    report.sha === input.featureSha &&
    report.contentId === input.contentId &&
    report.origin.sha === input.origin.sha &&
    report.origin.dirty === false &&
    report.status === 'passed' &&
    report.variant === 'all' &&
    report.checks.length > 0 &&
    report.checks.every((check) => check.status === 'passed') &&
    (mode !== 'full' ||
      (report.checks.length === expectedChecks.length &&
        expectedChecks.every((check) =>
          report.checks.some(
            (executed) =>
              executed.id === check.id &&
              JSON.stringify(executed.command) === JSON.stringify(check.command),
          ),
        )))
  );
};
const nativeValid = ['save', 'cancel', 'error'].every((scenario) => {
  const file = `artifacts/native-${process.platform}/${scenario}/verified.json`;
  if (!existsSync(file)) return false;
  const report = JSON.parse(readFileSync(file, 'utf8')) as {
    sha: string;
    contentId: string;
    os: string;
    cases: number;
  };
  return (
    report.sha === input.featureSha &&
    report.contentId === input.contentId &&
    report.os === process.platform &&
    report.cases > 0
  );
});
const passed =
  phases.every((phase) =>
    commands.some((command) => command.phase === phase && commandValid(command)),
  ) &&
  ['full', 'pre-pr', 'ci'].every(gateValid) &&
  nativeValid &&
  ['before-setup', 'after-setup', 'after-execution'].every((phase) => {
    const file = path.join(directory, `input-${phase}.json`);
    return existsSync(file) && inputValid(JSON.parse(readFileSync(file, 'utf8')) as typeof input);
  });
const report = {
  schema: 1,
  ...input,
  kind: 'hosted-native-support',
  execution: 'hosted-tools',
  status: passed ? 'passed' : 'blocked',
  os: process.platform,
  scope:
    'Supporting actual target-OS execution; does not claim independent Agent or commit/push completion',
  requiredSupportPhases: phases,
  commands,
  nativeValid,
  gates: Object.fromEntries(['full', 'pre-pr', 'ci'].map((mode) => [mode, gateValid(mode)])),
  versions: toolVersions(process.cwd()),
  artifacts: artifactSizes(process.cwd()),
};
writeFileSync(
  path.join(directory, 'hosted-desktop-support.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    featureSha: input.featureSha,
    contentId: input.contentId,
    status: report.status,
    os: report.os,
  }),
);
if (!passed) process.exitCode = 1;
