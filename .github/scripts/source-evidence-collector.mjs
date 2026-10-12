import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const carrier = process.cwd();
const config = JSON.parse(readFileSync(path.join(carrier, '.github/payload/source-evidence-input.json'), 'utf8'));
assert.equal(config.schema, 1);
assert.equal(config.kind, 'separate-mechanical-source-evidence');
assert.match(config.source.sha, /^[a-f0-9]{40}$/u);
assert.match(config.source.base, /^[a-f0-9]{40}$/u);
assert.match(config.source.contentId, /^[a-f0-9]{64}$/u);
assert.equal(process.env.GITHUB_REPOSITORY, 'sugar-cat7/super-starter');
assert.equal(process.env.GITHUB_REF, config.ownRef);
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
const source = path.join(carrier, '.state/validation-source');
const incoming = path.join(carrier, '.state/source-artifacts');
const evidence = path.join(carrier, '.state/strict-evidence');
const output = path.join(carrier, 'artifacts/source-collector');
const parts = path.join(carrier, '.state/source-export-parts');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const jsonFile = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, jsonBytes(value)); };
function safeRelative(file) {
  assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !file.includes('\\') && !file.includes('\0'));
  assert.ok(file.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe evidence path');
  return file;
}
function safeJoin(root, file) {
  const target = path.resolve(root, safeRelative(file));
  assert.ok(target.startsWith(path.resolve(root) + path.sep));
  return target;
}
function filesBelow(root) {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  const result = [];
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = safeRelative(prefix ? prefix + '/' + entry.name : entry.name);
      const full = path.join(directory, entry.name);
      assert.ok(!lstatSync(full).isSymbolicLink(), 'No evidence symlink: ' + file);
      if (entry.isDirectory()) collect(full, file);
      else { assert.ok(entry.isFile(), 'No special evidence file: ' + file); result.push(file); }
    }
  }
  collect(root);
  assert.ok(result.length <= config.limits.maxFiles);
  return result;
}
function clearGitEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const tmp = path.join(root, '.state/collector-tmp');
  mkdirSync(tmp, { recursive: true });
  return { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' };
}
function git(argv, root = source) {
  const result = spawnSync('git', argv, { cwd: root, env: clearGitEnvironment(root), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git guard failed: ' + (result.error?.message ?? result.stderr));
  return result.stdout.trim();
}
function guardCheckout() {
  assert.equal(git(['rev-parse', '--show-toplevel']), realpathSync(source));
  assert.equal(git(['rev-parse', 'HEAD']), config.source.sha);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(git(['rev-parse', 'HEAD'], carrier), process.env.GITHUB_SHA);
}
function utf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function noSecret(text, file) {
  assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text), 'Unsafe credential material; do not export: ' + file);
}
async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function artifactAllowed(name) {
  return name === 'source-evidence' || name === 'observability-evidence' || name === 'actual-worker-evidence-Windows' ||
    name === 'security-identifiers' || /^actual-native-evidence-(?:Linux|macOS|Windows)$/u.test(name) ||
    /^generated-evidence-[a-z0-9-]+-(?:Linux|macOS|Windows)$/u.test(name);
}
function selected(file) {
  const base = path.posix.basename(file);
  if (/(?:^|\/)(?:security|scanner|semgrep|gitleaks|gitguardian)(?:[/._-]|$)/iu.test(file))
    return base === 'security-report.json' || base === 'sanitization.json';
  if (file.includes('/lighthouse/')) return base === 'summary.json';
  return /^(?:gate-(?:full|ci|pre-pr|push|test|build)-[a-z-]+-(?:linux|darwin|win32)|generation|faults|hooks|lifecycle|sanitization|ci-plan|verified|summary|security-report)\.json$/u.test(base) || file.endsWith('.log');
}
async function prepare() {
  mkdirSync(output, { recursive: true });
  mkdirSync(parts, { recursive: true });
  guardCheckout();
  const { contentId } = await import(pathToFileURL(path.join(source, 'tools/quality/gate.ts')).href);
  const { lighthouseScores } = await import(pathToFileURL(path.join(source, 'tools/quality/test-results.ts')).href);
  assert.equal(contentId(source), config.source.contentId);
  const report = {
    schema: 1, kind: config.kind, execution: 'hosted-tools', status: 'running',
    source: config.source, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, originalRunsContextOnly: config.originalRuns,
    limitations: [config.classification, 'Original current-run artifacts retain all raw bytes, including large LHR/HTML/traces; only reviewed text proof and LHR summaries are emitted.', 'No cross-workflow download token, credentials or permissions are added.'],
    jobs: JSON.parse(process.env.COLLECTOR_NEEDS ?? '{}'), files: [], lighthouse: [], failures: []
  };
  const exportFiles = new Map();
  let bytesTotal = 0;
  const artifacts = readdirSync(incoming, { withFileTypes: true });
  for (const entry of artifacts) assert.ok(entry.isDirectory() && artifactAllowed(entry.name), 'Unexpected artifact scope: ' + entry.name);
  assert.ok(artifacts.some((entry) => entry.name === 'source-evidence'));
  for (const artifact of artifacts) {
    const root = path.join(incoming, artifact.name);
    for (const relative of filesBelow(root)) {
      const file = safeRelative(artifact.name + '/' + relative);
      const full = safeJoin(incoming, file);
      const size = statSync(full).size;
      assert.ok(size <= config.limits.maxFileBytes);
      bytesTotal += size;
      assert.ok(bytesTotal <= config.limits.maxArtifactBytes);
      const record = { path: file, size, sha256: await digestFile(full), exported: selected(file) };
      report.files.push(record);
      assert.ok(report.files.length <= config.limits.maxFiles);
      if (!record.exported) continue;
      assert.ok(size <= config.limits.maxJsonBytes, 'Text proof too large: ' + file);
      const bytes = readFileSync(full);
      const text = utf8(bytes);
      noSecret(text, file);
      if (file.endsWith('.json')) JSON.parse(text);
      exportFiles.set(file, bytes);
    }
  }
  const planFile = safeJoin(incoming, 'source-evidence/artifacts/ci-plan.json');
  const plan = JSON.parse(utf8(readFileSync(planFile)));
  assert.equal(plan.sha, config.source.sha);
  assert.equal(plan.base, config.source.base);
  assert.equal(plan.contentId, config.source.contentId);
  assert.equal(plan.fixtures, true);
  assert.equal(plan.native, true);
  assert.equal(plan.workers, true);
  assert.equal(plan.observability, true);
  assert.equal(plan.fixturesMatrix.include.length, 15, 'Complete original 15-row matrix is required');
  assert.deepEqual(plan.nativeMatrix.include.map((entry) => entry.os).sort(), ['macos-15', 'ubuntu-24.04', 'windows-2025']);
  for (const item of report.files.filter((item) => item.path.includes('/lighthouse/') && path.posix.basename(item.path) === 'summary.json')) {
    const summary = JSON.parse(utf8(readFileSync(safeJoin(incoming, item.path))));
    const validation = { path: item.path, sha256: item.sha256, sourceSha: summary.templateOrigin?.sha ?? summary.sha, contentId: summary.contentId, package: summary.package, os: summary.os, lighthouse: summary.lighthouse, chromium: summary.chromium, routes: summary.routes, profiles: summary.profiles, runs: [], status: 'passed' };
    try {
      assert.equal(summary.status, 'passed');
      assert.equal(summary.templateOrigin?.sha ?? summary.sha, config.source.sha, 'Raw LHR summary must name the exact Source');
      if (summary.templateOrigin) assert.equal(summary.templateOrigin.dirty, false);
      assert.match(summary.contentId, /^[a-f0-9]{64}$/u);
      assert.equal(summary.error, null);
      assert.equal(summary.lighthouse, '13.5.0');
      assert.deepEqual(summary.profiles, ['mobile', 'desktop']);
      assert.equal(summary.runsPerPage, 3);
      assert.ok(summary.routes.length > 0 && new Set(summary.routes).size === summary.routes.length);
      const root = path.posix.dirname(item.path).replace(/\/artifacts\/lighthouse\/[^/]+$/u, '');
      assert.notEqual(root, path.posix.dirname(item.path), 'LHR summary must use its owning artifact root');
      const expected = summary.routes.flatMap((route) => ['mobile', 'desktop'].flatMap((profile) => [1, 2, 3].map((run) => ({ route, profile, run }))));
      assert.equal(summary.runs.length, expected.length);
      for (const wanted of expected) {
        const matches = summary.runs.filter((run) => run.route === wanted.route && run.profile === wanted.profile && run.run === wanted.run);
        assert.equal(matches.length, 1, 'Exactly three official runs per page/profile');
        const run = matches[0];
        assert.equal(run.status, 'passed');
        const rawPath = safeRelative(root + '/' + safeRelative(run.json));
        const rawBytes = readFileSync(safeJoin(incoming, rawPath));
        assert.ok(rawBytes.length <= config.limits.maxJsonBytes);
        const raw = JSON.parse(utf8(rawBytes));
        const scores = lighthouseScores(raw, wanted.profile);
        assert.equal(raw.lighthouseVersion, summary.lighthouse);
        const expectedUrl = new URL(wanted.route, summary.origin).href;
        assert.equal(new URL(expectedUrl).hostname, '127.0.0.1');
        assert.equal(raw.requestedUrl, expectedUrl);
        assert.equal(raw.finalDisplayedUrl ?? raw.finalUrl, expectedUrl);
        for (const category of Object.values(raw.categories)) {
          assert.ok(Array.isArray(category.auditRefs) && category.auditRefs.length > 0, 'Complete category audit references are required');
          for (const ref of category.auditRefs ?? []) assert.ok(Object.hasOwn(raw.audits, ref.id), 'No missing category audit result');
        }
        const htmlPath = safeRelative(root + '/' + safeRelative(run.html));
        assert.ok(existsSync(safeJoin(incoming, htmlPath)));
        validation.runs.push({ ...wanted, rawPath, rawSha256: sha256(rawBytes), rawSize: rawBytes.length, requestedUrl: raw.requestedUrl, finalUrl: raw.finalDisplayedUrl ?? raw.finalUrl, lighthouseVersion: raw.lighthouseVersion, browserUserAgent: raw.environment?.networkUserAgent ?? raw.userAgent, profile: raw.configSettings.formFactor, throttling: raw.configSettings.throttling, screenEmulation: raw.configSettings.screenEmulation, throttlingMethod: raw.configSettings.throttlingMethod, scores, auditCount: Object.keys(raw.audits).length, categoryAuditCounts: Object.fromEntries(Object.entries(raw.categories).map(([id, value]) => [id, value.auditRefs?.length ?? 0])), exclusions: { skipAudits: raw.configSettings.skipAudits ?? null, onlyAudits: raw.configSettings.onlyAudits ?? null, onlyCategories: raw.configSettings.onlyCategories ?? null }, runtimeError: raw.runtimeError ?? null, htmlPath });
      }
    } catch (error) { validation.status = 'failed'; validation.error = String(error); report.failures.push(validation.error); }
    report.lighthouse.push(validation);
  }
  assert.ok(report.lighthouse.length > 0, 'Actual raw LHR evidence is required');
  mkdirSync(evidence, { recursive: true });
  // Only original artifact bytes enter the unchanged validator. Export summaries do not replace reports.
  for (const artifact of artifacts)
    for (const file of filesBelow(path.join(incoming, artifact.name))) {
      const from = path.join(incoming, artifact.name, file);
      const target = safeJoin(evidence, artifact.name + '/' + file);
      mkdirSync(path.dirname(target), { recursive: true });
      // Hard links preserve original bytes without copying large HTML/traces.
      const { linkSync } = await import('node:fs');
      linkSync(from, target);
    }
  const agents = config.agentPayload;
  assert.equal(agents.schema, 1);
  assert.ok(Array.isArray(agents.files));
  if (!agents.files.length) {
    assert.equal(agents.status, 'blocked');
    report.agentInput = { status: 'blocked', reason: agents.reason, files: [] };
  } else {
    assert.equal(agents.status, 'authenticated-genuine-receipts');
    const seen = new Set();
    report.agentInput = { status: agents.status, files: [] };
    for (const file of agents.files) {
      safeRelative(file.path);
      assert.match(file.path, /^agents\/(?:web-api|desktop|package-add)\/.+\.(?:json|log)$/u);
      assert.ok(!seen.has(file.path)); seen.add(file.path);
      const bytes = Buffer.from(file.bytes, 'base64');
      assert.equal(bytes.toString('base64'), file.bytes);
      assert.equal(sha256(bytes), file.sha256);
      noSecret(utf8(bytes), file.path);
      if (file.path.endsWith('.json')) JSON.parse(utf8(bytes));
      const target = safeJoin(evidence, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      exportFiles.set(file.path, bytes);
      report.agentInput.files.push({ path: file.path, sha256: file.sha256, size: bytes.length });
    }
  }
  const started = new Date();
  const argv = [process.execPath, 'tools/quality/acceptance.ts', '--evidence', evidence, '--sha', config.source.sha];
  const result = spawnSync(argv[0], argv.slice(1), { cwd: source, env: clearGitEnvironment(source), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const acceptanceLog = 'acceptance/command.log';
  const entry = { argv, cwd: source, started: started.toISOString(), ended: new Date().toISOString(), exit: result.status, signal: result.signal, error: result.error?.message, log: acceptanceLog };
  const logBytes = Buffer.from('argv: ' + JSON.stringify(argv) + '\n' + (result.stdout ?? '') + (result.stderr ?? '') + '\nresult: ' + JSON.stringify(entry) + '\n');
  noSecret(utf8(logBytes), acceptanceLog);
  exportFiles.set(acceptanceLog, logBytes);
  report.acceptanceCommand = entry;
  for (const name of ['acceptance.json', 'acceptance.md']) {
    const file = path.join(source, 'artifacts', name);
    if (existsSync(file)) exportFiles.set('acceptance/' + name, readFileSync(file));
  }
  const actual = JSON.parse(readFileSync(path.join(source, 'artifacts/acceptance.json'), 'utf8'));
  assert.equal(actual.sha, config.source.sha);
  report.acceptance = { status: actual.status, rows: actual.rows.map(({ preset, os, status }) => ({ preset, os, status })), mechanisms: actual.mechanisms.map(({ id, status }) => ({ id, status })) };
  assert.equal(contentId(source), config.source.contentId);
  guardCheckout();
  report.sourceJobStatus = report.jobs.required?.result;
  report.status = result.status === 0 && !result.error && !report.failures.length && report.jobs.required?.result === 'success' && report.jobs['security-scan']?.result === 'success' ? 'passed' : 'blocked';
  report.artifactBytes = bytesTotal;
  report.exportedFiles = [...exportFiles].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha256(bytes) }));
  jsonFile(path.join(output, 'collector-report.json'), report);
  exportFiles.set('collector/collector-report.json', jsonBytes(report));
  const chunks = [];
  for (const [file, bytes] of exportFiles) {
    for (let offset = 0; offset < bytes.length; offset += config.limits.chunkBytes)
      chunks.push({ path: file, offset, fileSize: bytes.length, fileSha256: sha256(bytes), bytes: bytes.subarray(offset, offset + config.limits.chunkBytes).toString('base64') });
    if (!bytes.length) chunks.push({ path: file, offset: 0, fileSize: 0, fileSha256: sha256(bytes), bytes: '' });
  }
  const groups = [];
  let current = [];
  for (const chunk of chunks) {
    if (jsonBytes({ schema: 1, chunks: [...current, chunk] }).length > config.limits.partBytes - 2048) { assert.ok(current.length); groups.push(current); current = []; }
    current.push(chunk);
  }
  if (current.length) groups.push(current);
  assert.ok(groups.length > 0 && groups.length < config.limits.maxParts);
  const names = groups.map((group, index) => {
    const name = 'part-' + String(index + 1).padStart(3, '0') + '.json';
    const bytes = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: config.source.sha, runId: process.env.GITHUB_RUN_ID, index: index + 1, total: groups.length + 1, chunks: group });
    assert.ok(bytes.length <= config.limits.partBytes);
    writeFileSync(path.join(parts, name), bytes);
    return name;
  });
  const manifest = { schema: 1, carrierSha: process.env.GITHUB_SHA, source: config.source, runId: process.env.GITHUB_RUN_ID, reportStatus: report.status, acceptanceExit: result.status, parts: names.map((name) => { const bytes = readFileSync(path.join(parts, name)); return { name, size: bytes.length, sha256: sha256(bytes) }; }) };
  jsonFile(path.join(output, 'parts-manifest.json'), manifest);
  const indexBytes = jsonBytes(manifest);
  const indexPart = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: config.source.sha, runId: process.env.GITHUB_RUN_ID, index: 0, total: groups.length + 1, chunks: [{ path: 'collector/parts-manifest.json', offset: 0, fileSize: indexBytes.length, fileSha256: sha256(indexBytes), bytes: indexBytes.toString('base64') }] });
  assert.ok(indexPart.length <= config.limits.partBytes);
  writeFileSync(path.join(parts, 'part-000.json'), indexPart);
  names.unshift('part-000.json');
  assert.ok(process.env.GITHUB_OUTPUT);
  appendFileSync(process.env.GITHUB_OUTPUT, 'parts=' + JSON.stringify(names) + '\n');
  console.log(JSON.stringify({ kind: config.kind, source: config.source, runId: process.env.GITHUB_RUN_ID, status: report.status, acceptanceExit: result.status, parts: names.length, limitations: report.limitations }));
  // A blocked/missing-Agent CLI execution remains a real failed step/job.
  if (result.error || result.status !== 0 || report.status !== 'passed') process.exitCode = 1;
}
function emit(name) {
  assert.match(name, /^part-[0-9]{3}\.json$/u);
  const bytes = readFileSync(path.join(parts, name));
  assert.ok(bytes.length <= config.limits.partBytes);
  const parsed = JSON.parse(utf8(bytes));
  assert.equal(parsed.carrierSha, process.env.GITHUB_SHA);
  assert.equal(parsed.sourceSha, config.source.sha);
  assert.equal(parsed.runId, process.env.GITHUB_RUN_ID);
  const chunks = bytes.toString('base64').match(/.{1,6000}/gu) ?? [];
  const header = { name, encoding: 'utf8+base64', size: bytes.length, sha256: sha256(bytes), chunks: chunks.length, sourceSha: config.source.sha, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID };
  console.log('SOURCE_EVIDENCE_PART_BEGIN ' + JSON.stringify(header));
  chunks.forEach((chunk, index) => console.log('SOURCE_EVIDENCE_PART_CHUNK ' + index + ' ' + chunk));
  console.log('SOURCE_EVIDENCE_PART_END');
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'guard') guardCheckout();
else if (args.length === 1 && args[0] === 'prepare') {
  try { await prepare(); }
  catch (error) {
    mkdirSync(output, { recursive: true });
    mkdirSync(parts, { recursive: true });
    const reason = String(error);
    const safeReason = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|PRIVATE KEY)/u.test(reason) ? 'Unsafe material encountered; retained source artifacts must be inspected privately' : reason;
    const failure = { schema: 1, kind: config.kind, status: 'failed', source: config.source, carrierSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, failure: safeReason, acceptancePassed: false };
    jsonFile(path.join(output, 'collector-failure.json'), failure);
    const raw = jsonBytes(failure);
    const part = jsonBytes({ schema: 1, carrierSha: process.env.GITHUB_SHA, sourceSha: config.source.sha, runId: process.env.GITHUB_RUN_ID, index: 0, total: 1, chunks: [{ path: 'collector/collector-failure.json', offset: 0, fileSize: raw.length, fileSha256: sha256(raw), bytes: raw.toString('base64') }] });
    writeFileSync(path.join(parts, 'part-000.json'), part);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'parts=["part-000.json"]\n');
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
else if (args.length === 2 && args[0] === 'emit') emit(args[1]);
else throw new Error('Expected guard | prepare | emit <part-NNN.json>');
