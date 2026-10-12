import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const carrier = realpathSync(process.cwd());
const config = JSON.parse(readFileSync(path.join(carrier, '.github/payload/final-acceptance-input.json'), 'utf8'));
const source = path.join(carrier, '.state/final-source');
const incoming = path.join(carrier, '.state/final-inputs');
const evidence = path.join(carrier, '.state/final-evidence');
const output = path.join(carrier, 'artifacts/final-acceptance');
const sourceSha = '653abf13ae3a54b2434c422ab8dc6800822387c3';
const sourceCid = '8a91208bf0be87ea59f830dd11d700618bfc46c75493dd9799b0c5c3815fff25';
const keys = ['web-api', 'desktop', 'package-add'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function writeJson(file, value) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, jsonBytes(value)); }
function noSecret(bytes, file) {
  assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(utf8(bytes)), 'Unsafe credential material: ' + file);
}
function relative(file) {
  assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !/[\u0000-\u001f\\]/u.test(file));
  assert.ok(file.split('/').every((part) => part && part !== '.' && part !== '..'));
  return file;
}
function ownedFile(root, file) {
  const parts = relative(file).split('/');
  let current = realpathSync(root);
  assert.ok(lstatSync(current).isDirectory());
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), 'No input symlink: ' + file);
    assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory());
  }
  assert.ok(realpathSync(current).startsWith(realpathSync(root) + path.sep));
  return current;
}
function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}
function git(root, argv) {
  const result = spawnSync('git', argv, { cwd: root, env: environment(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function checkout(root, sha) {
  assert.equal(git(root, ['rev-parse', '--show-toplevel']), realpathSync(root));
  assert.equal(git(root, ['rev-parse', 'HEAD']), sha);
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
}
function basics() {
  assert.equal(config.schema, 1); assert.equal(config.kind, 'lightweight-unchanged-source-acceptance');
  assert.equal(config.source.sha, sourceSha); assert.equal(config.source.contentId, sourceCid);
  assert.match(config.source.acceptanceCliSha256, /^[a-f0-9]{64}$/u);
  assert.equal(config.ownRef, 'refs/heads/codex/final-acceptance-653');
  assert.equal(process.env.GITHUB_REPOSITORY, 'sugar-cat7/super-starter');
  assert.equal(process.env.GITHUB_REF, config.ownRef);
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  checkout(carrier, process.env.GITHUB_SHA);
}
function pin(spec) {
  assert.ok(spec && typeof spec === 'object', 'Immutable evidence input unresolved');
  assert.match(spec.commit, /^[a-f0-9]{40}$/u);
}
function ready() {
  basics(); assert.equal(config.ready, true, 'Reviewed immutable inputs are not ready; draft must not execute');
  pin(config.sourcePayload);
  relative(config.sourcePayload.manifestPath);
  assert.match(config.sourcePayload.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(config.agents).sort(), [...keys].sort());
  for (const key of keys) {
    const spec = config.agents[key]; pin(spec);
    relative(spec.receiptPath); assert.match(spec.receiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(spec.featureSha, /^[a-f0-9]{40}$/u);
    assert.match(spec.contentId, /^[a-f0-9]{64}$/u);
    assert.match(spec.originContentId, /^[a-f0-9]{64}$/u);
    assert.ok(Array.isArray(spec.files) && spec.files.length > 1);
  }
}
function plan() {
  ready(); assert.ok(process.env.GITHUB_OUTPUT);
  const values = { source_payload: config.sourcePayload.commit, web_api: config.agents['web-api'].commit, desktop: config.agents.desktop.commit, package_add: config.agents['package-add'].commit };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''));
}
async function run() {
  ready(); checkout(source, sourceSha);
  assert.equal(hash(readFileSync(ownedFile(source, 'tools/quality/acceptance.ts'))), config.source.acceptanceCliSha256);
  const { contentId } = await import(pathToFileURL(ownedFile(source, 'tools/quality/gate.ts')));
  assert.equal(contentId(source), sourceCid);
  const seen = new Set(); const originals = []; let total = 0;
  function verify(root, file) {
    relative(file.path); relative(file.target);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= config.limits.maxFileBytes);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(!seen.has(file.target), 'Duplicate accepted input target'); seen.add(file.target);
    const bytes = readFileSync(ownedFile(root, file.path));
    assert.equal(bytes.length, file.size); assert.equal(hash(bytes), file.sha256);
    total += bytes.length; assert.ok(total <= config.limits.maxTotalBytes && seen.size <= config.limits.maxFiles);
    noSecret(bytes, file.path); if (file.path.endsWith('.json')) JSON.parse(utf8(bytes));
    const target = path.join(evidence, relative(file.target));
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes);
    originals.push({ root: path.relative(carrier, root), path: file.path, target: file.target, size: bytes.length, sha256: hash(bytes) });
    return bytes;
  }
  const payloadRoot = path.join(incoming, 'source');
  const payload = config.sourcePayload; checkout(payloadRoot, payload.commit);
  const manifestBytes = readFileSync(ownedFile(payloadRoot, payload.manifestPath));
  assert.equal(hash(manifestBytes), payload.manifestSha256); noSecret(manifestBytes, payload.manifestPath);
  const manifest = JSON.parse(utf8(manifestBytes));
  assert.equal(manifest.schema, 1); assert.equal(manifest.kind, 'verified-original-source-evidence-transport');
  assert.equal(manifest.source.sha, sourceSha); assert.equal(manifest.source.contentId, sourceCid);
  assert.match(manifest.collector.carrierSha, /^[a-f0-9]{40}$/u);
  assert.ok(Number.isSafeInteger(manifest.collector.runId) && manifest.collector.runId > 0);
  assert.equal(manifest.collector.sourceGatesPassed, true);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= config.limits.maxFiles);
  const all = new Map();
  for (const file of manifest.files) {
    relative(file.path); assert.ok(!all.has(file.path), 'Duplicate original source file'); all.set(file.path, file);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= config.limits.maxFileBytes);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    const from = ownedFile(payloadRoot, file.path); assert.equal(lstatSync(from).size, file.size);
    const bytes = readFileSync(from);
    assert.equal(bytes.length, file.size); assert.equal(hash(bytes), file.sha256); noSecret(bytes, file.path);
  }
  assert.ok(Array.isArray(manifest.acceptedFiles) && manifest.acceptedFiles.length > 0);
  for (const file of manifest.acceptedFiles) {
    assert.ok(all.has(file.path));
    assert.deepEqual(all.get(file.path), { path: file.path, size: file.size, sha256: file.sha256 });
    assert.match(file.target, /^(?:source-evidence|observability-evidence|actual-worker-evidence-Windows|actual-native-evidence-(?:Linux|macOS|Windows)|generated-evidence-[a-z0-9-]+-(?:Linux|macOS|Windows)|security-identifiers)\//u);
    assert.ok(!/(?:^|\/)(?:sanitization-controls|collector|acceptance)\//u.test(file.target), 'Controlled/historical validator reports stay outside accepted evidence');
    verify(payloadRoot, file);
  }
  relative(manifest.originalBlockedAcceptance.path);
  const original = all.get(manifest.originalBlockedAcceptance.path); assert.ok(original);
  const blockedBytes = readFileSync(ownedFile(payloadRoot, original.path));
  const blocked = JSON.parse(utf8(blockedBytes));
  assert.equal(blocked.sha, sourceSha); assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.rows.length === 15 && blocked.rows.every((row) => row.status === 'passed'));
  const sourceMechanisms = blocked.mechanisms.filter((item) => !item.id.startsWith('agent-'));
  assert.equal(sourceMechanisms.length, 11);
  assert.ok(sourceMechanisms.every((item) => item.status === 'passed'));
  assert.ok(keys.every((key) => blocked.mechanisms.some((item) => item.id === 'agent-' + (key === 'web-api' ? 'web-api' : key) && item.status === 'blocked')));
  mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'original-blocked-acceptance.json'), blockedBytes);
  for (const key of keys) {
    const spec = config.agents[key], root = path.join(incoming, key); checkout(root, spec.commit);
    const bytes = readFileSync(ownedFile(root, spec.receiptPath));
    assert.equal(hash(bytes), spec.receiptSha256); noSecret(bytes, spec.receiptPath);
    const receipt = JSON.parse(utf8(bytes));
    assert.equal(receipt.schema, 1); assert.equal(receipt.execution, 'agent'); assert.equal(receipt.independentContext, true);
    assert.equal(receipt.origin.sha, sourceSha); assert.equal(receipt.origin.dirty, false);
    assert.equal(receipt.origin.contentId, spec.originContentId);
    assert.equal(receipt.featureSha, spec.featureSha); assert.equal(receipt.contentId, spec.contentId);
    const receiptTarget = 'agents/' + key + '/agent-' + key + '.json';
    const report = spec.files.find((file) => file.path === spec.receiptPath);
    assert.ok(report); assert.equal(report.target, receiptTarget); assert.equal(report.sha256, spec.receiptSha256);
    for (const command of receipt.commands) {
      assert.match(command.log, /^logs\/[^/]+\.log$/u);
      const from = path.posix.dirname(spec.receiptPath) + '/' + command.log;
      const target = path.posix.dirname(receiptTarget) + '/' + command.log;
      assert.ok(spec.files.some((file) => file.path === from && file.target === target), 'Every original command log must have an immutable hash pin');
    }
    for (const file of spec.files) {
      assert.ok(file.target === receiptTarget || file.target.startsWith('agents/' + key + '/logs/'));
      verify(root, file);
    }
  }
  const inputProof = { schema: 1, source: config.source, sourcePayload: payload, originalCollector: manifest.collector, agents: Object.fromEntries(keys.map((key) => [key, { commit: config.agents[key].commit, receiptSha256: config.agents[key].receiptSha256 }])), originals, bytes: total };
  writeJson(path.join(output, 'verified-inputs.json'), inputProof);
  checkout(source, sourceSha); assert.equal(contentId(source), sourceCid);
  const argv = [process.execPath, 'tools/quality/acceptance.ts', '--evidence', evidence, '--sha', sourceSha];
  const started = new Date();
  const value = spawnSync(argv[0], argv.slice(1), { cwd: source, env: environment(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const command = { argv, cwd: source, started: started.toISOString(), ended: new Date().toISOString(), exit: value.status, signal: value.signal, error: value.error?.message ?? null };
  writeFileSync(path.join(output, 'acceptance.stdout.log'), value.stdout ?? Buffer.alloc(0));
  writeFileSync(path.join(output, 'acceptance.stderr.log'), value.stderr ?? Buffer.alloc(0));
  writeJson(path.join(output, 'command.json'), command);
  for (const name of ['acceptance.json', 'acceptance.md']) {
    const bytes = readFileSync(ownedFile(source, 'artifacts/' + name)); noSecret(bytes, name);
    writeFileSync(path.join(output, name), bytes);
  }
  checkout(source, sourceSha); assert.equal(contentId(source), sourceCid);
  checkout(payloadRoot, payload.commit); for (const key of keys) checkout(path.join(incoming, key), config.agents[key].commit);
  const actual = JSON.parse(readFileSync(path.join(output, 'acceptance.json')));
  assert.equal(actual.sha, sourceSha);
  console.log(JSON.stringify({ source: config.source, originalCollector: manifest.collector, actualExit: value.status, acceptanceStatus: actual.status }));
  assert.equal(value.error, undefined); assert.equal(value.signal, null); assert.equal(value.status, 0, 'Unchanged actual Source acceptance CLI did not pass');
  assert.equal(actual.status, 'passed');
}
function emit() {
  mkdirSync(output, { recursive: true });
  const names = ['failure.json', 'command.json', 'verified-inputs.json', 'acceptance.json', 'acceptance.md', 'acceptance.stdout.log', 'acceptance.stderr.log', 'original-blocked-acceptance.json'];
  const files = names.filter((name) => existsSync(path.join(output, name))).map((name) => {
    const bytes = readFileSync(ownedFile(output, name)); noSecret(bytes, name);
    return { path: name, size: bytes.length, sha256: hash(bytes), bytes: bytes.toString('base64') };
  });
  assert.ok(files.length > 0);
  const bytes = jsonBytes({ schema: 1, source: config.source, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, files });
  assert.ok(bytes.length <= config.limits.maxPlainBytes, 'Bounded export exceeded reviewed size; intact artifact remains original');
  const chunks = bytes.toString('base64').match(/.{1,6000}/gu) ?? [];
  console.log('FINAL_ACCEPTANCE_BEGIN ' + JSON.stringify({ size: bytes.length, sha256: hash(bytes), chunks: chunks.length, sourceSha, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID }));
  chunks.forEach((chunk, index) => console.log('FINAL_ACCEPTANCE_CHUNK ' + index + ' ' + chunk));
  console.log('FINAL_ACCEPTANCE_END');
}
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === 'plan') plan();
  else if (args.length === 1 && args[0] === 'run') await run();
  else if (args.length === 1 && args[0] === 'emit') emit();
  else throw new Error('Expected plan | run | emit');
} catch (error) {
  const reason = String(error);
  const safe = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|PRIVATE KEY)/u.test(reason) ? 'Unsafe credential material; inspect original artifacts privately' : reason;
  writeJson(path.join(output, 'failure.json'), { schema: 1, source: config.source, kind: config.kind, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, status: 'failed', acceptancePassed: false, phase: args[0] ?? null, failure: safe });
  console.error(safe); process.exitCode = 1;
}
