import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInput, fixedInput, transport } from './web-agent-input.mjs';

const directory = path.resolve('artifacts/agent-web-api');
const input = await assertInput();
const fixed = fixedInput();
const commands = JSON.parse(readFileSync(path.join(directory, 'commands.json'), 'utf8'));
const { agentCommandValid } = await import(pathToFileURL(path.resolve('tools/quality/acceptance.ts')).href);
const { globalChecks, packageChecks } = await import(pathToFileURL(path.resolve('tools/quality/definitions.ts')).href);
const { workspacePackages } = await import(pathToFileURL(path.resolve('tools/quality/graph.ts')).href);
const fullRegistry = [...globalChecks, ...workspacePackages(process.cwd()).flatMap(pkg => packageChecks(pkg, 'full'))];
const exact = identity => identity && identity.featureSha === fixed.featureSha && identity.contentId === fixed.contentId &&
  JSON.stringify(identity.origin) === JSON.stringify(transport.origin) && identity.clean && identity.supportSha === fixed.supportSha;
const logValid = relative => relative.startsWith('logs/') && relative.endsWith('.log') &&
  existsSync(path.join(directory, relative)) && statSync(path.join(directory, relative)).size > 0 &&
  realpathSync(path.join(directory, relative)).startsWith(realpathSync(path.join(directory, 'logs')) + path.sep);
const successful = entry => entry.exit === 0 && !entry.signal && !entry.spawnError && !entry.inputGuardError &&
  logValid(entry.log) && exact(entry.inputBefore) && exact(entry.inputAfter);
const required = [
  ['setup', ['pnpm', 'env:setup']],
  ['doctor', ['pnpm', 'env:doctor']],
  ['dev', ['pnpm', 'dev', '--', 'web']],
  ['targeted-test', ['pnpm', '--filter', '@independent-web/api', 'test']],
  ['targeted-test', ['pnpm', '--filter', '@independent-web/web', 'test']],
  ['pre-pr', ['pnpm', 'gate:pre-pr', '--', '--base', fixed.baseSha]],
  ['full', ['pnpm', 'gate:full']],
  ['ci', ['pnpm', 'gate:ci', '--', '--base', fixed.baseSha, '--checks', 'javascript']],
  ['build', ['pnpm', 'build']],
  ['preflight', ['pnpm', 'deploy:preflight', '--', '--target', 'api', '--environment', 'local']],
  ['preflight', ['pnpm', 'deploy:preflight', '--', '--target', 'web', '--environment', 'local']],
  ['push', ['git', 'push', '--set-upstream', 'origin', 'feat/notes-count']],
];
const commandsComplete = required.every(([phase, argv]) => commands.some(entry => entry.phase === phase &&
  JSON.stringify(entry.argv) === JSON.stringify(argv) && successful(entry) && (phase === 'ci' || agentCommandValid(phase, entry.argv))));
const commit = commands.find(entry => entry.phase === 'commit');
const commitValid = commit && commit.exit === 0 && !commit.signal && !commit.spawnError && !commit.inputGuardError &&
  logValid(commit.log) && agentCommandValid('commit', commit.argv) && commit.inputBefore.contentId === fixed.contentId &&
  JSON.stringify(commit.inputBefore.origin) === JSON.stringify(transport.origin) && commit.inputBefore.featureSha === fixed.baseSha &&
  exact(commit.inputAfter) && commit.inputBefore.featureSha !== commit.inputAfter.featureSha;
const gates = Object.fromEntries(['pre-pr', 'full', 'ci'].map(mode => {
  const variant = mode === 'ci' ? 'javascript' : 'all';
  const filename = `artifacts/gate-${mode}-${variant}-linux.json`;
  if (!existsSync(filename)) return [mode, false];
  const gate = JSON.parse(readFileSync(filename, 'utf8'));
  const shape = gate.sha === fixed.featureSha && gate.contentId === fixed.contentId &&
    JSON.stringify(gate.origin) === JSON.stringify(transport.origin) && gate.status === 'passed' && gate.variant === variant &&
    gate.checks.length > 0 && gate.checks.every(check => check.status === 'passed') &&
    (mode === 'full' ? gate.checks.length === fullRegistry.length && fullRegistry.every(check => gate.checks.some(actual =>
      actual.id === check.id && JSON.stringify(actual.command) === JSON.stringify(check.command))) : gate.base === fixed.baseSha);
  return [mode, shape];
}));
const identitiesValid = ['before-setup', 'after-setup', 'after-execution'].every(phase => {
  const file = path.join(directory, `input-${phase}.json`);
  return existsSync(file) && exact(JSON.parse(readFileSync(file, 'utf8')));
});
const bare = JSON.parse(readFileSync(path.join(directory, 'bare-push-proof.json'), 'utf8'));
const allObservedPassed = commands.every(entry => entry.exit === 0 && !entry.signal && !entry.spawnError && !entry.inputGuardError && logValid(entry.log));
const passed = commandsComplete && commitValid && identitiesValid && allObservedPassed && Object.values(gates).every(Boolean) &&
  bare.featureSha === fixed.featureSha && bare.normalHooks === true;
const { toolVersions, artifactSizes } = await import(pathToFileURL(path.resolve('tools/quality/evidence.ts')).href);
const report = { schema: 1, execution: 'hosted-tools', kind: 'hosted-web-api-support', status: passed ? 'passed' : 'blocked',
  scope: 'Mechanical execution only. Contains actual new-source normal Git events; the Agent authors the feature and separately reviews/assembles acceptance.',
  ...input, baseSha: fixed.baseSha, transport, commandsComplete, commitValid, allObservedPassed, identitiesValid, gates,
  commands, versions: toolVersions(process.cwd()), artifacts: artifactSizes(process.cwd()) };
writeFileSync(path.join(directory, 'hosted-web-api-support.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, featureSha: input.featureSha, contentId: input.contentId, gates, commitValid }));
if (!passed) process.exitCode = 1;
