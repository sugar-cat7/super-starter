import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = path.resolve('source');
const out = path.join(root, 'artifacts/source-fixture-verification');
mkdirSync(out, { recursive: true });
const payload = JSON.parse(readFileSync('support/.github/payload/candidate.json', 'utf8'));
const base = '0f9611c1c8e6934aa3f8d0fce924bcc9f4da9d5d';
const expectedPaths = ['.template.json', 'tools/generators/format.test.ts'];
const { foreignGitEnvironment } = await import(pathToFileURL(path.join(root, 'tools/quality/checkout.ts')));
const environment = foreignGitEnvironment(root);
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']) delete environment[key];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commands = [];
function run(phase, argv, { timeout = 30 * 60_000, env = environment, input, raw = false } = {}) {
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, timeout, maxBuffer: 12_000_000, env, input });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  const log = String(commands.length + 1).padStart(2, '0') + '-' + phase + '.log';
  writeFileSync(path.join(out, log), Buffer.concat([stdout, stderr]));
  commands.push({ phase, argv, milliseconds: Date.now() - started, exit: result.status, signal: result.signal, error: result.error?.message ?? null, log });
  writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  console.log(JSON.stringify(commands.at(-1)));
  console.log(stdout.toString());
  console.error(stderr.toString());
  assert.equal(result.status, 0, phase);
  return raw ? stdout : stdout.toString().trim();
}
function assertFiles() {
  for (const file of payload.files) assert.equal(hash(readFileSync(path.join(root, file.path))), file.afterSha256, file.path);
}
function assertScope(phase) {
  assert.deepEqual(run(phase + '-paths', ['git', 'diff', 'HEAD', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
  assert.equal(run(phase + '-untracked', ['git', 'ls-files', '--others', '--exclude-standard', '-z']), '');
  assert.equal(run(phase + '-head', ['git', 'rev-parse', 'HEAD']), base);
}
try {
  assert.equal(payload.sourceBase, base);
  assert.match(payload.candidate.sha, /^[a-f0-9]{40}$/);
  assert.deepEqual(payload.files.map((f) => f.path).sort(), expectedPaths);
  assert.equal(run('base', ['git', 'rev-parse', 'HEAD']), base);
  assert.equal(run('initial-clean', ['git', 'status', '--porcelain']), '');
  run('fetch-candidate', ['git', 'fetch', 'origin', payload.candidate.sha]);
  const rawCandidate = run('raw-candidate', ['git', 'cat-file', 'commit', payload.candidate.sha], { raw: true });
  writeFileSync(path.join(out, 'candidate-commit.txt'), rawCandidate);
  assert.equal(run('candidate-object', ['git', 'hash-object', '-t', 'commit', '--stdin'], { input: rawCandidate }), payload.candidate.sha);
  const separator = rawCandidate.indexOf(Buffer.from('\n\n'));
  assert.ok(separator > 0);
  const headers = rawCandidate.subarray(0, separator).toString('utf8').split('\n');
  assert.equal(headers.length, 4, 'Unsigned candidate has only tree, parent, author and committer');
  assert.equal(headers[0], 'tree ' + payload.candidate.tree.sha);
  assert.equal(headers[1], 'parent ' + base);
  function identity(line, kind) {
    const match = new RegExp('^' + kind + ' (.+) <([^<>\\n]+)> ([0-9]+) ([+-][0-9]{4})$').exec(line);
    assert.ok(match, kind);
    const value = { name: match[1], email: match[2], epoch: Number(match[3]), timezone: match[4] };
    assert.equal(value.name, payload.candidate[kind].name);
    assert.equal(value.email, payload.candidate[kind].email);
    assert.equal(new Date(value.epoch * 1000).toISOString(), new Date(payload.candidate[kind].date).toISOString());
    return value;
  }
  const author = identity(headers[2], 'author');
  const committer = identity(headers[3], 'committer');
  const message = rawCandidate.subarray(separator + 2);
  assert.equal(message.toString('utf8'), payload.requestedMessage);
  assert.equal(message.at(-1), 10);
  assert.notEqual(message.at(-2), 10);
  const messageFile = path.join(out, 'message.txt');
  writeFileSync(messageFile, message);
  for (const file of payload.files) assert.equal(hash(readFileSync(path.join(root, file.path))), file.beforeSha256);
  run('setup', ['pnpm', 'env:setup', '--', '--javascript']);
  assert.equal(run('prepared-clean', ['git', 'status', '--porcelain']), '');
  for (const file of payload.files) {
    assert.equal(hash(readFileSync(path.join(root, file.path))), file.beforeSha256);
    assert.equal(hash(Buffer.from(file.content)), file.afterSha256);
    writeFileSync(path.join(root, file.path), file.content);
  }
  assertFiles();
  assertScope('patched');
  run('doctor', ['pnpm', 'env:doctor', '--', '--javascript']);
  run('static', ['pnpm', 'check']);
  run('targeted', ['pnpm', 'test:tools', '--', 'tools/generators/format.test.ts'], { timeout: 180_000 });
  const tests = JSON.parse(readFileSync(path.join(root, 'artifacts/tests-default.json'), 'utf8'));
  assert.equal(tests.numTotalTests, 9);
  assert.equal(tests.numPassedTests, 9);
  assert.equal(tests.numFailedTests, 0);
  run('sync-check', ['node', 'tools/generators/cli.ts', 'sync', '--check', '--no-install']);
  assertFiles();
  assertScope('verified');
  assert.equal(run('pre-stage-index', ['git', 'diff', '--cached', '--name-only', '-z']), '');
  run('identity-name', ['git', 'config', '--local', 'user.name', committer.name]);
  run('identity-email', ['git', 'config', '--local', 'user.email', committer.email]);
  run('stage', ['git', 'add', '--', ...expectedPaths]);
  assert.deepEqual(run('staged-paths', ['git', 'diff', '--cached', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
  assert.equal(run('expected-tree', ['git', 'write-tree']), payload.candidate.tree.sha);
  const commitEnvironment = { ...environment, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: '@' + author.epoch + ' ' + author.timezone, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: '@' + committer.epoch + ' ' + committer.timezone };
  run('commit', ['git', 'commit', '--cleanup=verbatim', '-F', messageFile], { env: commitEnvironment });
  const head = run('committed-head', ['git', 'rev-parse', 'HEAD']);
  assert.equal(head, payload.candidate.sha, 'Ordinary hook-validated Git commit exactly reproduces the candidate');
  assert.equal(run('committed-clean', ['git', 'status', '--porcelain']), '');
  assertFiles();
  const rawActual = run('raw-actual', ['git', 'cat-file', 'commit', head], { raw: true });
  assert.deepEqual(rawActual, rawCandidate);
  writeFileSync(path.join(out, 'actual-commit.txt'), rawActual);
  const remote = path.join(root, '.state/verified-source-remote.git');
  run('bare', ['git', 'init', '--bare', remote]);
  run('seed-bare', ['git', '--git-dir', remote, 'fetch', root, base + ':refs/heads/source']);
  assert.equal(run('bare-base', ['git', '--git-dir', remote, 'rev-parse', 'refs/heads/source']), base);
  run('remote', ['git', 'remote', 'add', 'verified-source', remote]);
  run('push', ['git', 'push', 'verified-source', 'HEAD:refs/heads/source']);
  assert.equal(run('bare-tip', ['git', '--git-dir', remote, 'rev-parse', 'refs/heads/source']), head);
  assert.equal(run('final-head', ['git', 'rev-parse', 'HEAD']), head);
  assert.equal(run('final-clean', ['git', 'status', '--porcelain']), '');
  assertFiles();
  assert.deepEqual(run('final-source-diff', ['git', 'diff', base, '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
  const { contentId } = await import(pathToFileURL(path.join(root, 'tools/quality/gate.ts')));
  const cid = contentId(root);
  run('bundle', ['git', '-c', 'pack.threads=1', 'bundle', 'create', path.join(out, 'source.bundle'), 'HEAD', '^' + base]);
  const bundle = readFileSync(path.join(out, 'source.bundle'));
  const report = { schema: 1, kind: 'hosted-source-verification', execution: 'hosted-tools', status: 'passed', sourceBase: base, sourceSha: head, contentId: cid, supportSha: process.env.GITHUB_SHA, commands, files: payload.files.map(({ content, ...f }) => f), bundleSha256: hash(bundle), bundleBytes: bundle.length, exactRawCommit: true };
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('SOURCE_VERIFICATION_REPORT ' + JSON.stringify(report));
} catch (error) {
  writeFileSync(path.join(out, 'failed.json'), JSON.stringify({ schema: 1, kind: 'hosted-source-verification', status: 'failed', sourceBase: base, supportSha: process.env.GITHUB_SHA, commands, error: String(error) }, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
}
