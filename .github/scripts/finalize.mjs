import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve('source');
const out = path.join(root, 'artifacts/source-finalize');
mkdirSync(out, { recursive: true });
const patch = JSON.parse(readFileSync('support/.github/payload/patch.json', 'utf8'));
const expectedBase = '98312ce0a1441185e4cd25509d4dc694424b0317';
assert.equal(patch.baseSha, expectedBase);
const expectedPaths = ['.template.json', 'docs/quality.md', 'docs/template.md', 'tools/generators/cli.ts', 'tools/generators/format.test.ts', 'tools/generators/format.ts', 'tools/quality/faults.ts'].sort();
assert.deepEqual(patch.files.map((f) => f.path).sort(), expectedPaths);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const commands = [];
function run(phase, argv, milliseconds = 30 * 60_000) {
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: milliseconds, maxBuffer: 12_000_000, env: process.env });
  const log = `${String(commands.length + 1).padStart(2, '0')}-${phase}.log`;
  writeFileSync(path.join(out, log), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  commands.push({ phase, argv, milliseconds: Date.now() - started, exit: result.status, signal: result.signal, error: result.error?.message ?? null, log });
  writeFileSync(path.join(out, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`);
  console.log(JSON.stringify(commands.at(-1)));
  if (result.status !== 0) throw new Error(`${phase} failed: ${String(result.stderr).slice(-4000)}`);
  return result.stdout.trim();
}
function assertFiles() {
  for (const file of patch.files) {
    assert.equal(hash(readFileSync(path.join(root, file.path))), file.afterSha256, file.path);
  }
}
try {
  assert.equal(run('base', ['git', 'rev-parse', 'HEAD']), expectedBase);
  assert.equal(run('initial-clean', ['git', 'status', '--porcelain']), '');
  for (const file of patch.files) assert.equal(hash(readFileSync(path.join(root, file.path))), file.beforeSha256, file.path);
  for (const file of patch.files) writeFileSync(path.join(root, file.path), file.content);
  assertFiles();
  run('setup', ['pnpm', 'env:setup', '--', '--javascript']);
  assertFiles();
  run('doctor', ['pnpm', 'env:doctor', '--', '--javascript']);
  run('static', ['pnpm', 'check']);
  run('targeted', ['pnpm', 'test:tools', '--', 'tools/generators/format.test.ts']);
  assertFiles();
  run('author-name', ['git', 'config', '--local', 'user.name', 'Codex']);
  run('author-email', ['git', 'config', '--local', 'user.email', 'codex@localhost']);
  run('stage', ['git', 'add', '--', ...expectedPaths]);
  assert.deepEqual(run('staged-paths', ['git', 'diff', '--cached', '--name-only']).split('\n').sort(), expectedPaths);
  run('commit', ['git', 'commit', '-m', 'fix: finalize cold app scaffolds and deduplicate fault repairs']);
  assertFiles();
  const featureSha = run('head', ['git', 'rev-parse', 'HEAD']);
  assert.equal(run('clean', ['git', 'status', '--porcelain']), '');
  const remote = path.join(root, '.state/final-source-remote.git');
  run('bare', ['git', 'init', '--bare', remote]);
  run('seed-bare', ['git', '--git-dir', remote, 'fetch', root, `${expectedBase}:refs/heads/source`]);
  run('remote', ['git', 'remote', 'add', 'final-verification', remote]);
  run('push', ['git', 'push', 'final-verification', 'HEAD:refs/heads/source']);
  assert.equal(run('remote-head', ['git', '--git-dir', remote, 'rev-parse', 'refs/heads/source']), featureSha);
  assertFiles();
  assert.equal(run('final-clean', ['git', 'status', '--porcelain']), '');
  const { contentId } = await import(pathToFileURL(path.join(root, 'tools/quality/gate.ts')));
  const cid = contentId(root);
  const rawCommit = run('raw-commit', ['git', 'cat-file', 'commit', featureSha]);
  writeFileSync(path.join(out, 'commit.txt'), `${rawCommit}\n`);
  run('bundle', ['git', '-c', 'pack.threads=1', 'bundle', 'create', path.join(out, 'source.bundle'), 'HEAD', `^${expectedBase}`]);
  const bundle = readFileSync(path.join(out, 'source.bundle'));
  const report = { schema: 1, kind: 'hosted-source-verification', execution: 'hosted-tools', status: 'passed', sourceBase: expectedBase, sourceSha: featureSha, contentId: cid, supportSha: process.env.GITHUB_SHA, files: patch.files.map(({ content, ...file }) => file), commands, bundleSha256: hash(bundle), bundleBytes: bundle.length };
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', sourceSha: featureSha, contentId: cid, bundleSha256: hash(bundle) }));
} catch (error) {
  writeFileSync(path.join(out, 'failed.json'), `${JSON.stringify({ schema: 1, kind: 'hosted-source-verification', execution: 'hosted-tools', status: 'failed', sourceBase: expectedBase, supportSha: process.env.GITHUB_SHA, commands, error: String(error) }, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
}
