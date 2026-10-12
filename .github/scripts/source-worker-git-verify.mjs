import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.cwd();
const carrier = path.join(workspace, 'support');
const root = path.join(workspace, 'source');
const out = path.join(workspace, 'artifacts/source-worker-git');
const parts = path.join(workspace, '.state/source-worker-git-parts');
const payload = JSON.parse(readFileSync(path.join(carrier, '.github/payload/source-worker-git-input.json'), 'utf8'));
const base = '460ad19c970adaab7231795f3438943d9158b135';
const baseCid = 'd674216f6fd7d5a03b3b0f2bbf3b54f0ee83f75779542f6b7d0a8eab62499337';
const expectedPaths = ['.template.json', 'packages/api/src/notes.ts', 'packages/api/test/unit.test.ts', 'packages/sample-api/src/notes.ts', 'packages/sample-api/test/unit.test.ts', 'tools/generators/templates/api/test/unit.test.ts.template', 'tools/generators/templates/worker/notes.ts.template'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const commands = [];
const exported = new Map();
const metadataFields = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'];
const report = { schema: 1, kind: payload.kind, execution: 'hosted-tools', status: 'running', sourceBase: base, qualityBase: payload.qualityBase, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, preparation: payload.prepared, commands, classification: payload.classification };
let environment, baselineIndex, baselineFiles, contentId;
function safe(file) {
  assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !/[\x00-\x1f\x7f\\]/u.test(file));
  assert.ok(file.split('/').every((item) => item && item !== '.' && item !== '..'));
  return file;
}
function writeReport() { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, 'verification-report.json'), jsonBytes(report)); }
function git(argv, { cwd = root, input, bytes = false } = {}) {
  const result = spawnSync('git', argv, { cwd, env: environment, input, encoding: bytes ? undefined : 'utf8', timeout: 60_000, maxBuffer: 12_000_000 });
  assert.equal(result.error, undefined, 'Git guard error');
  assert.equal(result.signal, null, 'Git guard signal');
  assert.equal(result.status, 0, 'Git guard exit: ' + (result.stderr?.toString() ?? ''));
  return bytes ? result.stdout : result.stdout.trim();
}
function clean() { assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), ''); }
function carrierClean() { assert.equal(git(['rev-parse', '--show-toplevel'], { cwd: carrier }), carrier); assert.equal(git(['rev-parse', 'HEAD'], { cwd: carrier }), process.env.GITHUB_SHA); assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: carrier }), ''); }
function hooks() {
  assert.equal(git(['config', '--get', 'core.hooksPath']), 'tools/quality/git-hooks');
  for (const event of ['pre-commit', 'pre-push']) {
    const file = path.join(root, 'tools/quality/git-hooks', event);
    assert.ok(lstatSync(file).isFile() && (lstatSync(file).mode & 0o111) !== 0);
    assert.ok(readFileSync(file).equals(baselineFiles.get('tools/quality/git-hooks/' + event).bytes));
  }
}
function snapshot() {
  const index = git(['ls-files', '--stage', '-z'], { bytes: true });
  const files = new Map(index.toString().split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/u.exec(entry);
    assert.ok(match, 'Only ordinary tracked Source files are allowed');
    const [, mode, gitBlobSha, file] = match; safe(file);
    const stat = lstatSync(path.join(root, file)); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return [file, { bytes: readFileSync(path.join(root, file)), mode, gitBlobSha, fileMode: stat.mode & 0o7777 }];
  }));
  return { index, files };
}
function protectedFiles(patched) {
  for (const [file, before] of baselineFiles) {
    const stat = lstatSync(path.join(root, file)); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o7777, before.fileMode, 'Source file mode changed: ' + file);
    const expected = patched && expectedPaths.includes(file) ? Buffer.from(payload.files.find((item) => item.path === file).content, 'utf8') : before.bytes;
    assert.ok(readFileSync(path.join(root, file)).equals(expected), 'Source bytes changed: ' + file);
  }
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '-z']), '');
}
function beforeCommit(staged) {
  carrierClean();
  assert.equal(git(['rev-parse', 'HEAD']), base);
  protectedFiles(true);
  assert.deepEqual(git(['diff', 'HEAD', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
  assert.equal(contentId(root), payload.prepared.contentId);
  if (staged) {
    assert.deepEqual(git(['diff', '--cached', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
    assert.equal(git(['diff', '--name-only']), '');
    assert.equal(git(['write-tree']), payload.candidate.treeSha);
  } else {
    assert.ok(git(['ls-files', '--stage', '-z'], { bytes: true }).equals(baselineIndex), 'Source index changed before exact staging');
    assert.equal(git(['diff', '--cached', '--name-only']), '');
  }
  hooks();
}
function afterCommit() {
  carrierClean();
  assert.equal(git(['rev-parse', 'HEAD']), payload.candidate.sha);
  clean(); protectedFiles(true); hooks();
  assert.equal(contentId(root), payload.prepared.contentId);
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), payload.candidate.treeSha);
  assert.deepEqual(git(['diff', base, '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedPaths);
}
function run(label, argv, { timeout = 30 * 60_000, env = environment, input, raw = false } = {}) {
  const started = new Date();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, timeout, maxBuffer: 12_000_000, env, input });
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  const prefix = 'logs/' + String(commands.length + 1).padStart(2, '0') + '-' + label;
  for (const [channel, bytes] of [['stdout', stdout], ['stderr', stderr]]) {
    const name = prefix + '.' + channel + '.log';
    exported.set(name, bytes); mkdirSync(path.dirname(path.join(out, name)), { recursive: true }); writeFileSync(path.join(out, name), bytes);
  }
  const entry = { label, argv, cwd: root, started: started.toISOString(), ended: new Date().toISOString(), exit: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: { path: prefix + '.stdout.log', size: stdout.length, sha256: hash(stdout) }, stderr: { path: prefix + '.stderr.log', size: stderr.length, sha256: hash(stderr) } };
  commands.push(entry); writeReport();
  console.log(JSON.stringify(entry)); process.stdout.write(stdout); process.stderr.write(stderr);
  assert.equal(result.error, undefined, label + ': command error'); assert.equal(result.signal, null, label + ': signal'); assert.equal(result.status, 0, label + ': actual exit');
  return raw ? stdout : stdout.toString().trim();
}
function validateInputs() {
  assert.equal(payload.schema, 1); assert.equal(payload.kind, 'exact-worker-source-normal-git-verification');
  assert.equal(payload.status, 'reviewed-candidate', 'No null or unreviewed candidate may execute');
  assert.equal(process.env.GITHUB_REPOSITORY, 'sugar-cat7/super-starter');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/source-worker-fix-verify-460');
  assert.equal(payload.ownRef, process.env.GITHUB_REF); assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(payload.sourceBase.sha, base); assert.equal(payload.sourceBase.contentId, baseCid);
  assert.equal(payload.qualityBase, '63dc03962359d3164da0d34fbcdc1ccb2cec455f');
  assert.ok(payload.candidate, 'A Root-created immutable candidate is mandatory');
  assert.match(payload.candidate.sha, /^[a-f0-9]{40}$/u); assert.match(payload.candidate.treeSha, /^[a-f0-9]{40}$/u);
  assert.equal(payload.candidate.parentSha, base);
  assert.match(payload.prepared.contentId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(payload.files.map((file) => file.path).sort(), expectedPaths);
  assert.ok(payload.candidate.message.endsWith('\n') && !payload.candidate.message.endsWith('\n\n'));
  for (const item of payload.files) {
    safe(item.path); assert.equal(item.mode, '100644'); assert.match(item.gitBlobSha, /^[a-f0-9]{40}$/u); assert.match(item.beforeGitBlobSha, /^[a-f0-9]{40}$/u);
    const bytes = Buffer.from(item.content, 'utf8'); new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.equal(bytes.length, item.size); assert.equal(hash(bytes), item.sha256);
  }
}
async function verify() {
  validateInputs();
  const { foreignGitEnvironment } = await import(pathToFileURL(path.join(root, 'tools/quality/checkout.ts')));
  environment = foreignGitEnvironment(root);
  for (const field of metadataFields) delete environment[field];
  const tmp = path.join(root, '.state/normal-git-tmp'); mkdirSync(tmp, { recursive: true });
  Object.assign(environment, { TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' });
  carrierClean();
  assert.equal(git(['rev-parse', '--show-toplevel']), root);
  assert.equal(git(['rev-parse', 'HEAD']), base); clean();
  const baseline = snapshot(); baselineIndex = baseline.index; baselineFiles = baseline.files;
  for (const file of payload.files) {
    assert.equal(hash(baselineFiles.get(file.path).bytes), file.beforeSha256);
    assert.equal(baselineFiles.get(file.path).gitBlobSha, file.beforeGitBlobSha);
    assert.equal(git(['hash-object', '--stdin'], { input: Buffer.from(file.content, 'utf8') }), file.gitBlobSha);
  }
  run('fetch-exact-candidate', ['git', 'fetch', 'origin', payload.candidate.sha]);
  const rawCandidate = run('read-raw-candidate', ['git', 'cat-file', 'commit', payload.candidate.sha], { raw: true });
  exported.set('candidate-commit.txt', rawCandidate); writeFileSync(path.join(out, 'candidate-commit.txt'), rawCandidate);
  assert.equal(git(['hash-object', '-t', 'commit', '--stdin'], { input: rawCandidate }), payload.candidate.sha);
  assert.ok(Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(rawCandidate)).equals(rawCandidate));
  const separator = rawCandidate.indexOf(Buffer.from('\n\n')); assert.ok(separator > 0);
  const headers = rawCandidate.subarray(0, separator).toString('utf8').split('\n');
  assert.equal(headers.length, 4, 'Reject signatures, duplicate parents and extra headers');
  assert.equal(headers[0], 'tree ' + payload.candidate.treeSha); assert.equal(headers[1], 'parent ' + base);
  function identity(line, kind) {
    const match = new RegExp('^' + kind + ' ([^<>\\x00-\\x1f\\x7f]+) <([^<>\\x00-\\x1f\\x7f]+)> ([0-9]+) ([+-][0-9]{4})$').exec(line);
    assert.ok(match, kind + ' strict raw identity');
    const value = { name: match[1], email: match[2], epoch: Number(match[3]), timezone: match[4] };
    assert.ok(Number.isSafeInteger(value.epoch)); assert.deepEqual(value, payload.candidate[kind]);
    return value;
  }
  const author = identity(headers[2], 'author'), committer = identity(headers[3], 'committer');
  const message = rawCandidate.subarray(separator + 2); assert.ok(message.equals(Buffer.from(payload.candidate.message, 'utf8')));
  const messageFile = path.join(out, 'message.txt'); writeFileSync(messageFile, message); exported.set('message.txt', message);
  run('normal-javascript-setup', ['pnpm', 'env:setup', '--', '--javascript']);
  clean(); protectedFiles(false); hooks();
  ({ contentId } = await import(pathToFileURL(path.join(root, 'tools/quality/gate.ts'))));
  assert.equal(contentId(root), baseCid);
  assert.ok(git(['ls-files', '--stage', '-z'], { bytes: true }).equals(baselineIndex));
  for (const file of payload.files) writeFileSync(path.join(root, file.path), Buffer.from(file.content, 'utf8'));
  beforeCommit(false);
  run('normal-doctor', ['pnpm', 'env:doctor', '--', '--javascript']); beforeCommit(false);
  run('normal-static-quality', ['pnpm', 'check']); beforeCommit(false);
  for (const [pkg, directory] of [['@starter/api', 'api'], ['@starter/sample-api', 'sample-api']]) {
    run(directory + '-unit', ['pnpm', '--filter', pkg, 'test']); beforeCommit(false);
    const bytes = readFileSync(path.join(root, 'packages', directory, 'artifacts/tests-vitest.config.ts.json'));
    exported.set('sdk/' + directory + '-unit.json', bytes);
    const value = JSON.parse(bytes); assert.equal(value.success, true); assert.equal(value.numFailedTests, 0); assert.equal(value.numPendingTests, 0); assert.equal(value.numTotalTests, 14); assert.equal(value.numPassedTests, 14);
    run(directory + '-real-runtime', ['pnpm', '--filter', pkg, 'test:runtime']); beforeCommit(false);
    const runtimeBytes = readFileSync(path.join(root, 'packages', directory, 'artifacts/tests-vitest.runtime.config.ts.json'));
    exported.set('sdk/' + directory + '-runtime.json', runtimeBytes);
    const runtime = JSON.parse(runtimeBytes); assert.equal(runtime.success, true); assert.equal(runtime.numFailedTests, 0); assert.equal(runtime.numPendingTests, 0); assert.equal(runtime.numTotalTests, 4); assert.equal(runtime.numPassedTests, 4);
  }
  run('normal-template-check', ['pnpm', 'template:sync', '--', '--check']); beforeCommit(false);
  run('local-identity-name', ['git', 'config', '--local', 'user.name', committer.name]);
  run('local-identity-email', ['git', 'config', '--local', 'user.email', committer.email]);
  run('stage-only-seven-files', ['git', 'add', '--', ...expectedPaths]); beforeCommit(true);
  const commitEnvironment = { ...environment, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: '@' + author.epoch + ' ' + author.timezone, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: '@' + committer.epoch + ' ' + committer.timezone };
  run('ordinary-hooked-commit', ['git', 'commit', '--cleanup=verbatim', '-F', messageFile], { env: commitEnvironment });
  afterCommit();
  const rawActual = run('read-raw-actual', ['git', 'cat-file', 'commit', 'HEAD'], { raw: true });
  assert.ok(rawActual.equals(rawCandidate), 'Ordinary hooked commit must exactly reproduce every candidate byte');
  exported.set('actual-commit.txt', rawActual); writeFileSync(path.join(out, 'actual-commit.txt'), rawActual);
  const remote = path.join(root, '.state/verified-worker-source.git');
  assert.ok(!existsSync(remote), 'Owned bare destination must be new');
  run('initialize-owned-bare', ['git', 'init', '--bare', remote]);
  run('seed-owned-bare-base', ['git', '--git-dir', remote, 'fetch', root, base + ':refs/heads/source']);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/source']), base);
  run('configure-owned-bare', ['git', 'remote', 'add', 'verified-worker-source', remote]);
  afterCommit();
  run('ordinary-hooked-push', ['git', 'push', 'verified-worker-source', 'HEAD:refs/heads/source']);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/source']), payload.candidate.sha);
  afterCommit();
  const treeBytes = git(['ls-tree', '-r', '-z', 'HEAD'], { bytes: true });
  exported.set('head-tree.txt', treeBytes);
  const headFiles = [];
  for (const entry of treeBytes.toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry); assert.ok(match);
    const [, mode, blobSha, file] = match; safe(file);
    const bytes = readFileSync(path.join(root, file));
    assert.equal(createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex'), blobSha);
    exported.set('head-files/' + file, bytes);
    headFiles.push({ path: file, mode, gitBlobSha: blobSha, size: bytes.length, sha256: hash(bytes) });
  }
  run('ordinary-owned-bundle', ['git', '-c', 'pack.threads=1', 'bundle', 'create', path.join(out, 'source.bundle'), 'HEAD', '^' + base]);
  const bundle = readFileSync(path.join(out, 'source.bundle')); exported.set('source.bundle', bundle);
  afterCommit();
  report.status = 'passed'; report.sourceSha = payload.candidate.sha; report.treeSha = payload.candidate.treeSha; report.contentId = contentId(root); report.exactRawCommit = true;
  report.files = payload.files.map(({ content, ...file }) => file); report.headFiles = headFiles;
  report.bundle = { size: bundle.length, sha256: hash(bundle) }; report.finalClean = true; report.installedHooks = 'tools/quality/git-hooks';
  report.hookEvidence = { preCommit: commands.find((item) => item.label === 'ordinary-hooked-commit'), prePush: commands.find((item) => item.label === 'ordinary-hooked-push') };
  writeReport();
}
function pack() {
  mkdirSync(parts, { recursive: true }); exported.set('verification-report.json', jsonBytes(report));
  const segments = [];
  for (const [file, bytes] of exported) {
    safe(file); mkdirSync(path.dirname(path.join(out, file)), { recursive: true }); writeFileSync(path.join(out, file), bytes);
    const encoding = file === 'source.bundle' || file.startsWith('head-files/') && file.endsWith('.png') ? 'binary' : 'utf-8';
    if (encoding === 'utf-8') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text), 'Unsafe material must not be emitted');
    }
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += payload.limits.chunkBytes)
      segments.push({ path: file, encoding, offset, fileSize: bytes.length, fileSha256: hash(bytes), bytes: bytes.subarray(offset, offset + payload.limits.chunkBytes).toString('base64') });
  }
  const groups = []; let current = [];
  for (const segment of segments) {
    if (jsonBytes({ chunks: [...current, segment] }).length > payload.limits.partBytes - 2048) { assert.ok(current.length); groups.push(current); current = []; }
    current.push(segment);
  }
  if (current.length) groups.push(current); assert.ok(groups.length > 0 && groups.length < payload.limits.maxParts);
  const names = groups.map((chunks, index) => {
    const name = 'part-' + String(index + 1).padStart(3, '0') + '.json';
    const bytes = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: payload.candidate?.sha ?? null, runId: process.env.GITHUB_RUN_ID, index: index + 1, total: groups.length + 1, chunks });
    assert.ok(bytes.length <= payload.limits.partBytes); writeFileSync(path.join(parts, name), bytes); return name;
  });
  const manifest = { schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: payload.candidate?.sha ?? null, runId: process.env.GITHUB_RUN_ID, status: report.status, parts: names.map((name) => { const bytes = readFileSync(path.join(parts, name)); return { name, size: bytes.length, sha256: hash(bytes) }; }) };
  const bytes = jsonBytes(manifest);
  const index = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: payload.candidate?.sha ?? null, runId: process.env.GITHUB_RUN_ID, index: 0, total: groups.length + 1, chunks: [{ path: 'parts-manifest.json', encoding: 'utf-8', offset: 0, fileSize: bytes.length, fileSha256: hash(bytes), bytes: bytes.toString('base64') }] });
  assert.ok(index.length <= payload.limits.partBytes); writeFileSync(path.join(parts, 'part-000.json'), index); names.unshift('part-000.json');
  writeFileSync(path.join(out, 'parts-manifest.json'), bytes);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'parts=' + JSON.stringify(names) + '\n');
}
function emit(name) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'sugar-cat7/super-starter'); assert.equal(process.env.GITHUB_REF, payload.ownRef);
  assert.match(name, /^part-[0-9]{3}\.json$/u); const bytes = readFileSync(path.join(parts, name)); assert.ok(bytes.length <= payload.limits.partBytes);
  const value = JSON.parse(bytes);
  assert.equal(value.carrierSha, process.env.GITHUB_SHA); assert.equal(value.sourceSha, payload.candidate.sha); assert.equal(value.runId, process.env.GITHUB_RUN_ID);
  const chunks = bytes.toString('base64').match(/.{1,6000}/gu) ?? [];
  console.log('SOURCE_GIT_PART_BEGIN ' + JSON.stringify({ name, encoding: 'utf8+base64', size: bytes.length, sha256: hash(bytes), chunks: chunks.length, sourceSha: payload.candidate.sha, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID }));
  chunks.forEach((chunk, index) => console.log('SOURCE_GIT_PART_CHUNK ' + index + ' ' + chunk)); console.log('SOURCE_GIT_PART_END');
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'verify') {
  try { await verify(); } catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
  finally { writeReport(); pack(); console.log(JSON.stringify({ status: report.status, sourceSha: report.sourceSha, contentId: report.contentId, error: report.error })); }
} else if (args.length === 2 && args[0] === 'emit') emit(args[1]);
else throw new Error('Expected verify | emit <part-NNN.json>');
