import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const carrier = process.cwd();
const source = path.join(carrier, '.state/fix-source');
const output = path.join(carrier, 'artifacts/source-worker-fix');
const parts = path.join(carrier, '.state/source-worker-fix-parts');
const input = JSON.parse(readFileSync(path.join(carrier, '.github/payload/source-worker-fix-input.json'), 'utf8'));
assert.equal(input.schema, 1);
assert.equal(input.kind, 'source-worker-storage-isolation-preparation');
assert.equal(process.env.GITHUB_REPOSITORY, 'sugar-cat7/super-starter');
assert.equal(process.env.GITHUB_REF, input.ownRef);
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, jsonBytes(value)); };
const commands = [];
const report = { schema: 1, kind: input.kind, execution: 'hosted-tools', status: 'running', source: input.source, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, commands, classification: input.classification };
const exported = new Map();
let processTools, contentId, foreignGitEnvironment, baselineIndex, baselineFiles, baselineCid;
const allowed = new Set(input.expectedPaths);
const unitTemplate = 'tools/generators/templates/api/test/unit.test.ts.template';
const workerTemplate = 'tools/generators/templates/worker/notes.ts.template';
const units = ['packages/api/test/unit.test.ts', 'packages/sample-api/test/unit.test.ts'];
const production = ['packages/api/src/notes.ts', 'packages/sample-api/src/notes.ts'];
function safe(file) {
  assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !/[\x00-\x1f\x7f\\]/u.test(file));
  assert.ok(file.split('/').every((item) => item && item !== '.' && item !== '..'));
  return file;
}
function fallbackEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const tmp = path.join(root, '.state/fix-tmp');
  mkdirSync(tmp, { recursive: true });
  return { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' };
}
function environment() { return foreignGitEnvironment ? { ...foreignGitEnvironment(source), ...Object.fromEntries(Object.entries(fallbackEnvironment(source)).filter(([key]) => ['TMPDIR','TMP','TEMP','CLOUDFLARE_SEND_METRICS','WRANGLER_SEND_METRICS'].includes(key))) } : fallbackEnvironment(source); }
function git(argv, options = {}) {
  const result = spawnSync('git', argv, { cwd: options.cwd ?? source, env: environment(), encoding: options.bytes ? undefined : 'utf8', input: options.input, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git guard failed: ' + (result.error?.message ?? result.stderr));
  return options.bytes ? result.stdout : result.stdout.trim();
}
function basicGuard() {
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: carrier }), process.env.GITHUB_SHA);
  assert.equal(git(['rev-parse', 'HEAD']), input.source.sha);
  assert.equal(git(['rev-parse', '--show-toplevel']), source);
}
function payload(file, expectedPath) {
  assert.ok(file && file.path === expectedPath, 'Only reviewed owning blueprint input is allowed');
  assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.ok(typeof file.content === 'string' && file.content.length > 0);
  const bytes = Buffer.from(file.content, 'utf8');
  assert.ok(bytes.length > 0);
  assert.match(file.gitBlobSha ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(git(['hash-object', '--stdin'], { input: bytes }), file.gitBlobSha);
  assert.equal(hash(bytes), file.sha256);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}
function reviewedInputs() {
  assert.equal(input.status, 'reviewed-ready', 'Draft has no reviewed production/regression payload; do not execute');
  assert.equal(input.review.status, 'independently-reviewed');
  assert.ok(input.review.expectedNewCases.length > 0);
  const cases = input.review.expectedNewCases;
  assert.equal(new Set(cases.map((item) => item.title)).size, cases.length);
  for (const item of cases) assert.ok(typeof item.title === 'string' && item.title && typeof item.failureIncludes === 'string' && item.failureIncludes);
  return { unit: payload(input.review.reviewedUnitBlueprint, unitTemplate), worker: payload(input.review.reviewedWorkerBlueprint, workerTemplate), cases };
}
function snapshot() {
  const index = git(['ls-files', '--stage', '-z'], { bytes: true });
  const files = new Map(index.toString().split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/u.exec(entry);
    assert.ok(match, 'Only ordinary tracked baseline files are allowed');
    const [, mode, gitBlobSha, file] = match;
    safe(file);
    const stat = lstatSync(path.join(source, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return [file, { bytes: readFileSync(path.join(source, file)), mode, gitBlobSha, fileMode: stat.mode & 0o7777 }];
  }));
  return { index, files, cid: contentId(source) };
}
function scopeGuard(expectExact = false, phaseAllowed = allowed) {
  basicGuard();
  assert.ok(git(['ls-files', '--stage', '-z'], { bytes: true }).equals(baselineIndex), 'User index must remain unchanged throughout preparation');
  assert.equal(git(['diff', '--cached', '--name-only']), '');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '-z']), '', 'No new untracked source is permitted');
  const changed = git(['diff', '--name-only', '--no-renames']).split('\n').filter(Boolean);
  assert.ok(changed.every((file) => phaseAllowed.has(file)), 'Unexpected changed Source path');
  if (expectExact) assert.deepEqual([...changed].sort(), [...allowed].sort(), 'Final Source diff must be exactly the seven reviewed paths');
  for (const [file, baseline] of baselineFiles) {
    const bytes = readFileSync(path.join(source, file));
    if (!phaseAllowed.has(file)) assert.ok(bytes.equals(baseline.bytes), 'Protected Source changed: ' + file);
    const stat = lstatSync(path.join(source, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o7777, baseline.fileMode, 'Baseline file mode changed: ' + file);
  }
  return { head: input.source.sha, contentId: contentId(source), changed };
}
function preserve(file, key) { const bytes = readFileSync(file); exported.set(key, bytes); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function unitAssertions(value) {
  assert.equal(value.numPendingTests, 0);
  assert.equal(value.numTodoTests ?? 0, 0);
  assert.ok(value.numTotalTests > 0 && Array.isArray(value.testResults));
  return value.testResults.flatMap((suite) => suite.assertionResults ?? []);
}
async function run(argv, label, options = {}) {
  const before = baselineFiles ? scopeGuard(false, options.scope ?? allowed) : null;
  const started = new Date();
  const name = 'logs/' + String(commands.length + 1).padStart(2, '0') + '-' + label + '.log';
  const file = path.join(output, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'argv: ' + JSON.stringify(argv) + '\ncwd: ' + source + '\n');
  const child = processTools.spawnOwned(argv[0], argv.slice(1), { cwd: source, env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  child.stdout.on('data', (chunk) => { appendFileSync(file, chunk); process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { appendFileSync(file, chunk); process.stderr.write(chunk); });
  child.once('error', (error) => { failure = String(error); });
  const closed = new Promise((resolve) => child.once('close', (exit, signal) => resolve({ exit, signal })));
  const timer = setTimeout(() => { failure = 'Owned preparation command deadline exceeded'; processTools.stopTree(child).catch((error) => { failure = String(error); }); }, options.timeout ?? 20 * 60_000);
  const result = await closed;
  clearTimeout(timer);
  try { await processTools.stopTree(child); } catch (error) { failure = String(error); }
  const after = baselineFiles ? scopeGuard(false, options.scope ?? allowed) : null;
  const entry = { argv, label, cwd: source, started: started.toISOString(), ended: new Date().toISOString(), exit: result.exit, signal: result.signal, failure, log: name, before, after };
  commands.push(entry);
  appendFileSync(file, '\nresult: ' + JSON.stringify(entry) + '\n');
  exported.set(name, readFileSync(file));
  writeJson(path.join(output, 'preparation-report.json'), report);
  if (failure || result.signal !== null || result.exit !== (options.expectedExit ?? 0)) throw new Error(label + ': ' + (failure ?? 'unexpected actual exit/signal ' + result.exit + '/' + result.signal));
  return entry;
}
async function prepare() {
  mkdirSync(output, { recursive: true });
  const reviewed = reviewedInputs();
  basicGuard();
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '');
  processTools = await import(pathToFileURL(path.join(source, 'tools/process.ts')).href);
  ({ foreignGitEnvironment } = await import(pathToFileURL(path.join(source, 'tools/quality/checkout.ts')).href));
  await run(['pnpm', 'env:setup', '--', '--javascript'], 'normal-javascript-setup');
  ({ contentId } = await import(pathToFileURL(path.join(source, 'tools/quality/gate.ts')).href));
  assert.equal(contentId(source), input.source.contentId);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '');
  const baseline = snapshot();
  baselineIndex = baseline.index; baselineFiles = baseline.files; baselineCid = baseline.cid;
  assert.equal(baselineCid, input.source.contentId);
  assert.equal(allowed.size, 7);
  assert.deepEqual([...allowed].sort(), [unitTemplate, workerTemplate, ...units, ...production, '.template.json'].sort());
  for (const item of reviewed.cases) assert.ok(!baselineFiles.get(unitTemplate).bytes.toString().includes(item.title), 'The reviewed new case must be new to old production');
  writeFileSync(path.join(source, unitTemplate), reviewed.unit);
  const negativeScope = new Set([unitTemplate, ...units, '.template.json']);
  await run(['pnpm', 'template:sync'], 'regression-only-normal-template-sync', { scope: negativeScope });
  assert.ok(readFileSync(path.join(source, workerTemplate)).equals(baselineFiles.get(workerTemplate).bytes));
  for (const file of production) assert.ok(readFileSync(path.join(source, file)).equals(baselineFiles.get(file).bytes), 'Pre-fix production must remain exactly old bytes');
  await run(['pnpm', '--filter', '@starter/api', 'test'], 'actual-before-fix-api-unit', { expectedExit: 1, scope: negativeScope });
  const resultFile = path.join(source, 'packages/api/artifacts/tests-vitest.config.ts.json');
  const negative = preserve(resultFile, 'negative/api-unit.json');
  const assertions = unitAssertions(negative);
  const failed = assertions.filter((item) => item.status === 'failed');
  assert.equal(negative.success, false);
  assert.equal(negative.numFailedTests, reviewed.cases.length);
  assert.deepEqual(failed.map((item) => item.title).sort(), reviewed.cases.map((item) => item.title).sort());
  assert.ok(assertions.every((item) => item.status === 'passed' || item.status === 'failed'));
  assert.equal(assertions.length, negative.numTotalTests);
  assert.equal(negative.numPassedTests, negative.numTotalTests - reviewed.cases.length);
  // Vitest JSON preserves the matcher/stack, but abbreviates the expected object.
  // Join that original witness with the original per-case console diagnostic.
  const retentionAssertion = 'expect(await listed.json()).toContainEqual(note);';
  const renderedLines = readFileSync(path.join(source, units[0]), 'utf8').split('\n');
  const retentionLines = renderedLines.flatMap((line, index) => line.trim() === retentionAssertion ? [index + 1] : []);
  assert.equal(retentionLines.length, 1, 'The owning rendered suite must have one exact retention assertion');
  const retentionLine = retentionLines[0];
  const diagnosticLines = exported.get(commands.at(-1).log).toString('utf8').replace(/\u001b\[[0-9;]*m/gu, '').split('\n');
  for (const item of reviewed.cases) {
    const message = failed.find((test) => test.title === item.title).failureMessages.join('\n');
    assert.ok(/to (?:deeply|deep equally) contain/u.test(message) && message.includes(path.join(source, units[0]) + ':' + retentionLine + ':'), 'Actual JSON failure must point to the exact owning retention assertion');
    const headings = diagnosticLines.flatMap((line, index) =>
      /^\s*FAIL\s+test\/unit\.test\.ts\s+>/u.test(line) && line.endsWith(' > ' + item.title) ? [index] : []);
    assert.equal(headings.length, 1, 'Each reviewed failure must have one original console diagnostic');
    const start = headings[0];
    const following = diagnosticLines.findIndex((line, index) => index > start && /^\s*FAIL\s+/u.test(line));
    const diagnostic = diagnosticLines.slice(start, following < 0 ? diagnosticLines.length : following).join('\n');
    assert.ok(diagnostic.includes(item.failureIncludes) && diagnostic.includes(retentionAssertion) && /AssertionError: expected \[\] to (?:deeply|deep equally) contain/u.test(diagnostic), 'Original diagnostic must prove retention toContainEqual(note), not an earlier API/SDK/matcher error');
  }
  report.beforeFix = { status: 'actual_expected_failure', command: commands.at(-1), total: negative.numTotalTests, failed: failed.map((item) => ({ title: item.title, fullName: item.fullName, failureMessages: item.failureMessages })) };
  writeFileSync(path.join(source, workerTemplate), reviewed.worker);
  await run(['pnpm', 'template:sync'], 'reviewed-fix-normal-template-sync');
  await run(['pnpm', 'exec', 'vp', 'fmt', '--check', ...production, ...units], 'owning-sdk-format-check');
  await run(['pnpm', 'check'], 'normal-static-quality');
  for (const [pkg, directory] of [['@starter/api', 'api'], ['@starter/sample-api', 'sample-api']]) {
    await run(['pnpm', '--filter', pkg, 'test'], directory + '-unit');
    const value = preserve(path.join(source, 'packages', directory, 'artifacts/tests-vitest.config.ts.json'), 'positive/' + directory + '-unit.json');
    const tests = unitAssertions(value);
    assert.equal(value.success, true); assert.equal(value.numFailedTests, 0);
    assert.equal(value.numTotalTests, negative.numTotalTests);
    for (const item of reviewed.cases) assert.ok(tests.some((test) => test.title === item.title && test.status === 'passed'));
    await run(['pnpm', '--filter', pkg, 'test:runtime'], directory + '-real-worker-runtime');
  }
  await run(['pnpm', 'test:tools'], 'complete-tools-suite');
  const tools = preserve(path.join(source, 'artifacts/tests-default.json'), 'positive/tools.json');
  assert.equal(tools.success, true); assert.equal(tools.numFailedTests, 0); assert.equal(tools.numPendingTests, 0); assert.equal(tools.numTotalTests, 212);
  await run(['pnpm', 'template:sync', '--', '--check'], 'final-template-ownership-check');
  report.final = scopeGuard(true);
  report.modifiedFiles = input.expectedPaths.map((file) => {
    const bytes = readFileSync(path.join(source, file));
    const blob = git(['hash-object', '--stdin'], { input: bytes });
    exported.set('modified/' + file, bytes);
    return { path: file, mode: baselineFiles.get(file).mode, size: bytes.length, sha256: hash(bytes), gitBlobSha: blob };
  });
  report.finalIndexUnchanged = true;
  report.status = 'prepared';
  writeJson(path.join(output, 'preparation-report.json'), report);
}
function pack() {
  mkdirSync(parts, { recursive: true });
  const logs = path.join(output, 'logs');
  if (existsSync(logs)) for (const file of readdirSync(logs)) {
    assert.match(file, /^[0-9]{2}-[a-z-]+\.log$/u);
    exported.set('logs/' + file, readFileSync(path.join(logs, file)));
  }
  // Preserve actual SDK reporter bytes even if a command or later scope guard failed.
  for (const directory of ['artifacts', 'packages/api/artifacts', 'packages/sample-api/artifacts']) {
    const root = path.join(source, directory);
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root)) {
      if (/^tests-[a-zA-Z0-9._-]+\.json$/u.test(file))
        exported.set('sdk/' + directory + '/' + file, readFileSync(path.join(root, file)));
    }
  }
  exported.set('preparation-report.json', jsonBytes(report));
  const segments = [];
  for (const [file, bytes] of exported) {
    safe(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text), 'Unsafe material must not be emitted');
    for (let offset = 0; offset < bytes.length; offset += input.limits.chunkBytes) segments.push({ path: file, offset, fileSize: bytes.length, fileSha256: hash(bytes), bytes: bytes.subarray(offset, offset + input.limits.chunkBytes).toString('base64') });
  }
  const groups = []; let current = [];
  for (const segment of segments) { if (jsonBytes({ chunks: [...current, segment] }).length > input.limits.partBytes - 2048) { assert.ok(current.length); groups.push(current); current = []; } current.push(segment); }
  if (current.length) groups.push(current);
  assert.ok(groups.length > 0 && groups.length < input.limits.maxParts);
  const names = groups.map((chunks, index) => {
    const name = 'part-' + String(index + 1).padStart(3, '0') + '.json';
    const bytes = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: input.source.sha, runId: process.env.GITHUB_RUN_ID, index: index + 1, total: groups.length + 1, chunks });
    assert.ok(bytes.length <= input.limits.partBytes); writeFileSync(path.join(parts, name), bytes); return name;
  });
  const manifest = { schema: 1, carrierSha: process.env.GITHUB_SHA, source: input.source, runId: process.env.GITHUB_RUN_ID, status: report.status, parts: names.map((name) => { const bytes = readFileSync(path.join(parts, name)); return { name, size: bytes.length, sha256: hash(bytes) }; }) };
  const bytes = jsonBytes(manifest);
  const index = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: input.source.sha, runId: process.env.GITHUB_RUN_ID, index: 0, total: groups.length + 1, chunks: [{ path: 'parts-manifest.json', offset: 0, fileSize: bytes.length, fileSha256: hash(bytes), bytes: bytes.toString('base64') }] });
  assert.ok(index.length <= input.limits.partBytes); writeFileSync(path.join(parts, 'part-000.json'), index); names.unshift('part-000.json');
  writeJson(path.join(output, 'parts-manifest.json'), manifest);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'parts=' + JSON.stringify(names) + '\n');
}
function emit(name) {
  assert.match(name, /^part-[0-9]{3}\.json$/u);
  const bytes = readFileSync(path.join(parts, name));
  assert.ok(bytes.length <= input.limits.partBytes);
  const value = JSON.parse(bytes);
  assert.equal(value.carrierSha, process.env.GITHUB_SHA); assert.equal(value.sourceSha, input.source.sha); assert.equal(value.runId, process.env.GITHUB_RUN_ID);
  const chunks = bytes.toString('base64').match(/.{1,6000}/gu) ?? [];
  console.log('SOURCE_FIX_PART_BEGIN ' + JSON.stringify({ name, encoding: 'utf8+base64', size: bytes.length, sha256: hash(bytes), chunks: chunks.length, sourceSha: input.source.sha, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID }));
  chunks.forEach((chunk, index) => console.log('SOURCE_FIX_PART_CHUNK ' + index + ' ' + chunk));
  console.log('SOURCE_FIX_PART_END');
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'prepare') {
  try { await prepare(); } catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
  finally { mkdirSync(output, { recursive: true }); writeJson(path.join(output, 'preparation-report.json'), report); pack(); console.log(JSON.stringify({ status: report.status, source: input.source, error: report.error, final: report.final })); }
} else if (args.length === 2 && args[0] === 'emit') emit(args[1]);
else throw new Error('Expected prepare | emit <part-NNN.json>');
