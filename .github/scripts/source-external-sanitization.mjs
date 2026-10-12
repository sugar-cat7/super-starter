import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = realpathSync(process.cwd());
const sourceSha = '653abf13ae3a54b2434c422ab8dc6800822387c3';
const sourceCid = '8a91208bf0be87ea59f830dd11d700618bfc46c75493dd9799b0c5c3815fff25';
const profileSha = '38f2cbe9f89f18109fe04fd7705a2385ca304937bb7d25ed7a7868ac553a5f04';
const external = realpathSync(process.env.SOURCE_SANITIZATION_EXTERNAL);
assert.ok(external !== root && !external.startsWith(root + path.sep), 'External profile and controls must stay physically outside Source');
const controls = path.join(external, 'controls'); mkdirSync(controls, { recursive: true });
const profile = path.join(external, 'rules.json');
const profileBytes = readFileSync(profile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(profileBytes), profileSha);
const rules = JSON.parse(profileBytes);
assert.equal(rules.length, 6); assert.ok(rules.every((rule) => !Object.hasOwn(rule, 'allow')));
const { foreignGitEnvironment } = await import(pathToFileURL(path.join(root, 'tools/quality/checkout.ts')));
const { contentId } = await import(pathToFileURL(path.join(root, 'tools/quality/gate.ts')));
const { workspacePackages } = await import(pathToFileURL(path.join(root, 'tools/quality/graph.ts')));
const environment = foreignGitEnvironment(root);
for (const field of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']) delete environment[field];
const cli = path.join(root, 'tools/quality/sanitize.ts');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function command(argv, cwd, expected = 0, env = environment) {
  const started = new Date();
  const value = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: undefined, timeout: 120_000, maxBuffer: 8_000_000 });
  assert.equal(value.error, undefined, 'Command execution error'); assert.equal(value.signal, null, 'Command interrupted');
  return { argv, cwd, started: started.toISOString(), ended: new Date().toISOString(), exit: value.status, expected, stdout: value.stdout ?? Buffer.alloc(0), stderr: value.stderr ?? Buffer.alloc(0) };
}
function git(argv, cwd = root, env = environment) {
  const result = command(['git', ...argv], cwd, 0, env); assert.equal(result.exit, 0, 'Git guard'); return result.stdout.toString().trim();
}
function sourceGuard() {
  assert.equal(git(['rev-parse', '--show-toplevel']), root); assert.equal(git(['rev-parse', 'HEAD']), sourceSha);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(contentId(root), sourceCid);
}
function filesBelow(directory, relative = '') {
  const result = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const file = relative ? relative + '/' + entry.name : entry.name;
    const stat = lstatSync(path.join(directory, file)); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) result.push(...filesBelow(directory, file));
    else { assert.ok(stat.isFile()); result.push(file); }
  }
  return result;
}
function builtOutputs() {
  const gate = JSON.parse(readFileSync(path.join(root, 'artifacts/gate-ci-javascript-linux.json'), 'utf8'));
  assert.equal(gate.sha, sourceSha); assert.equal(gate.contentId, sourceCid); assert.equal(gate.status, 'passed');
  const packages = workspacePackages(root);
  const builds = gate.checks.filter((check) => check.id.endsWith('/build'));
  assert.ok(builds.length > 0 && builds.every((check) => check.status === 'passed'), 'Actual successful owning builds are required before sanitization');
  return builds.map((check) => {
    const pkg = packages.find((item) => item.name === check.package); assert.ok(pkg);
    const dist = path.join(root, pkg.directory, 'dist'); assert.ok(existsSync(dist) && lstatSync(dist).isDirectory());
    const files = filesBelow(dist).map((file) => { const bytes = readFileSync(path.join(dist, file)); return { path: pkg.directory + '/dist/' + file, size: bytes.length, sha256: hash(bytes) }; });
    assert.ok(files.length > 0 && files.some((file) => file.size > 0), 'Built output must be present and nonempty');
    return { package: pkg.name, check: check.id, files };
  });
}
sourceGuard();
const beforeBuild = builtOutputs();
const witnesses = [
  { name: 'brand', text: '"name": "cutt"', expected: ['source-product-brand'] },
  { name: 'scope', text: '"@cutt/', expected: ['source-product-brand', 'source-workspace-scope'] },
  { name: 'layout', text: 'tools/agent-harness/', expected: ['source-layout-and-harness'] },
  { name: 'media', text: '"@remotion/', expected: ['source-media-sdk'] },
  { name: 'runner', text: 'runs-on: [self-hosted', expected: ['private-runner-coupling'] },
  { name: 'updater', text: 'tauri-plugin-updater', expected: ['native-updater-coupling'] },
];
const summary = { schema: 1, kind: 'external-source-sanitization-support', execution: 'hosted-tools', sourceSha, sourceCid, profileSha256: profileSha, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, controls: [], builtOutputs: beforeBuild, status: 'running', classification: 'External controlled fail/repair/pass bytes are preserved separately and excluded from accepted Source evidence. The original Source CLI owns the final actual build scan.' };
writeFileSync(path.join(controls, 'summary.json'), jsonBytes(summary));
for (const witness of witnesses) {
  const directory = mkdtempSync(path.join(external, 'control-' + witness.name + '-'));
  assert.ok(!directory.startsWith(root + path.sep));
  writeFileSync(path.join(directory, '.template.json'), jsonBytes({ schema: 1, kind: 'verification-control' }));
  writeFileSync(path.join(directory, 'package.json'), jsonBytes({ name: 'source-sanitization-control', private: true }));
  writeFileSync(path.join(directory, '.gitignore'), 'artifacts/\n');
  mkdirSync(path.join(directory, 'docs'), { recursive: true });
  writeFileSync(path.join(directory, 'docs/witness.txt'), witness.text + '\n');
  git(['init'], directory);
  const controlEnvironment = foreignGitEnvironment(directory);
  for (const field of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']) delete controlEnvironment[field];
  git(['config', '--local', 'user.name', 'Source sanitization control'], directory, controlEnvironment);
  git(['config', '--local', 'user.email', 'source-sanitization-control@example.invalid'], directory, controlEnvironment);
  git(['add', '--', '.template.json', 'package.json', '.gitignore', 'docs/witness.txt'], directory, controlEnvironment);
  git(['commit', '-m', 'Own external sanitization control baseline'], directory, controlEnvironment);
  assert.equal(git(['rev-parse', '--show-toplevel'], directory, controlEnvironment), directory);
  const head = git(['rev-parse', 'HEAD'], directory, controlEnvironment), cid = contentId(directory);
  const controlIndex = git(['ls-files', '--stage', '-z'], directory, controlEnvironment);
  const result = command([process.execPath, cli, '--rules', profile], directory, 1, controlEnvironment);
  const destination = path.join(controls, witness.name); mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, 'stdout.log'), result.stdout); writeFileSync(path.join(destination, 'stderr.log'), result.stderr);
  const bytes = readFileSync(path.join(directory, 'artifacts/sanitization.json')); writeFileSync(path.join(destination, 'sanitization.json'), bytes);
  const value = JSON.parse(bytes);
  assert.equal(result.exit, 1, 'Each actual controlled scan must fail');
  assert.equal(value.status, 'failed'); assert.equal(value.sha, head); assert.equal(value.contentId, cid); assert.deepEqual(value.rules, rules);
  assert.deepEqual(value.failures.map((failure) => failure.rule).sort(), [...witness.expected].sort());
  assert.ok(value.failures.every((failure) => failure.file === 'docs/witness.txt'));
  const entry = { name: witness.name, expectedRules: witness.expected, head, contentId: cid, reportSha256: hash(bytes), argv: result.argv, cwd: directory, started: result.started, ended: result.ended, exit: result.exit, classification: 'actual-controlled-negative-only' };
  summary.controls.push(entry); writeFileSync(path.join(controls, 'summary.json'), jsonBytes(summary));
  // Repair only this same owned witness, preserving its real failing baseline.
  writeFileSync(path.join(directory, 'docs/witness.txt'), 'Source sanitization control repaired.\n');
  const repairedCid = contentId(directory); assert.notEqual(repairedCid, cid, 'Repair must change the canonical control content ID');
  assert.equal(git(['rev-parse', 'HEAD'], directory, controlEnvironment), head);
  assert.equal(git(['ls-files', '--stage', '-z'], directory, controlEnvironment), controlIndex);
  assert.equal(git(['diff', '--name-only'], directory, controlEnvironment), 'docs/witness.txt');
  const repaired = command([process.execPath, cli, '--rules', profile], directory, 0, controlEnvironment);
  writeFileSync(path.join(destination, 'repair.stdout.log'), repaired.stdout); writeFileSync(path.join(destination, 'repair.stderr.log'), repaired.stderr);
  const repairedBytes = readFileSync(path.join(directory, 'artifacts/sanitization.json')); writeFileSync(path.join(destination, 'repair-sanitization.json'), repairedBytes);
  const repairedValue = JSON.parse(repairedBytes);
  assert.equal(repaired.exit, 0, 'Actual same-input repaired scan must pass'); assert.equal(repairedValue.status, 'passed');
  assert.equal(repairedValue.sha, head); assert.equal(repairedValue.contentId, repairedCid); assert.deepEqual(repairedValue.rules, rules); assert.deepEqual(repairedValue.failures, []);
  assert.equal(git(['rev-parse', 'HEAD'], directory, controlEnvironment), head);
  assert.equal(git(['ls-files', '--stage', '-z'], directory, controlEnvironment), controlIndex);
  assert.equal(git(['diff', '--name-only'], directory, controlEnvironment), 'docs/witness.txt');
  entry.repair = { argv: repaired.argv, cwd: directory, started: repaired.started, ended: repaired.ended, exit: repaired.exit, head, contentId: repairedCid, reportSha256: hash(repairedBytes), onlyChangedPath: 'docs/witness.txt', indexUnchanged: true, classification: 'actual-same-input-repair-only' };
  writeFileSync(path.join(controls, 'summary.json'), jsonBytes(summary));
  sourceGuard();
}
sourceGuard(); assert.deepEqual(builtOutputs(), beforeBuild);
const final = command([process.execPath, cli, '--rules', profile], root);
writeFileSync(path.join(controls, 'final-source.stdout.log'), final.stdout); writeFileSync(path.join(controls, 'final-source.stderr.log'), final.stderr);
process.stdout.write(final.stdout); process.stderr.write(final.stderr);
const accepted = readFileSync(path.join(root, 'artifacts/sanitization.json'));
const value = JSON.parse(accepted);
assert.equal(final.exit, 0, 'Final actual Source build scan must pass'); assert.equal(value.status, 'passed'); assert.equal(value.sha, sourceSha); assert.equal(value.contentId, sourceCid); assert.deepEqual(value.rules, rules); assert.deepEqual(value.failures, []);
sourceGuard(); assert.deepEqual(builtOutputs(), beforeBuild);
summary.status = 'passed'; summary.final = { argv: final.argv, cwd: root, started: final.started, ended: final.ended, exit: final.exit, reportSha256: hash(accepted), controlsPassed: summary.controls.length };
assert.equal(summary.controls.length, 6); assert.ok(summary.controls.every((control) => control.repair?.exit === 0));
writeFileSync(path.join(controls, 'summary.json'), jsonBytes(summary));
writeFileSync(path.join(root, 'artifacts/sanitization-support.json'), jsonBytes(summary));
console.log(JSON.stringify({ kind: summary.kind, status: summary.status, sourceSha, sourceCid, controls: 6, builtPackages: beforeBuild.length, profileSha256: profileSha }));
