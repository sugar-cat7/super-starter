import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Mechanical support only. The independent Agent authored the supplied patch.
const transport = process.cwd();
const payload = path.join(transport, '.github/payload');
const input = JSON.parse(readFileSync(path.join(payload, 'status-agent-input.json'), 'utf8'));
const output = path.join(transport, 'artifacts/hosted-agent-add');
const source = path.join(transport, '.state/hosted-status-feature');
mkdirSync(path.join(output, 'logs'), { recursive: true });
mkdirSync(path.join(transport, '.state/tmp'), { recursive: true });
const environment = { ...process.env, TMPDIR: path.join(transport, '.state/tmp'), TMP: path.join(transport, '.state/tmp'), TEMP: path.join(transport, '.state/tmp'), CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' };
const commands = [];
const auxiliaryCommands = [];
const report = { schema: 1, execution: 'hosted-tools', kind: 'hosted-feature-support', status: 'running', task: input.task, origin: input.origin, inputContentId: input.featureContentId, baselineSha: input.baselineSha, transportSha: process.env.GITHUB_SHA, featureSha: null, contentId: input.featureContentId, commands, auxiliaryCommands, os: `${process.platform}/${process.arch}`, node: process.version };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shellFree = (argv, cwd = transport) => {
  const started = new Date();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: environment, encoding: 'utf8', timeout: 60_000 });
  const ended = new Date();
  const log = `logs/aux-${String(auxiliaryCommands.length + 1).padStart(3, '0')}.log`;
  const entry = { argv, cwd, exit: result.status, signal: result.signal, started: started.toISOString(), ended: ended.toISOString(), durationMs: ended - started, error: result.error?.message, log };
  writeFileSync(path.join(output, log), `argv: ${JSON.stringify(argv)}\ncwd: ${cwd}\n${result.stdout ?? ''}${result.stderr ?? ''}\nresult: ${JSON.stringify(entry)}\n`);
  auxiliaryCommands.push(entry);
  if (result.error || result.status !== 0) throw new Error(`${argv[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const save = () => writeFileSync(path.join(output, 'hosted-feature-support.json'), `${JSON.stringify(report, null, 2)}\n`);
let processTools;
let contentId;
let expectedHead;
let committed = false;
const identity = () => {
  const state = JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8'));
  return { head: shellFree(['git', 'rev-parse', 'HEAD'], source), contentId: contentId(source), origin: state.origin, status: shellFree(['git', 'status', '--porcelain=v1', '--untracked-files=all'], source) };
};
const guard = () => {
  const current = identity();
  assert.equal(current.head, expectedHead, 'Exact owned HEAD changed');
  assert.equal(current.contentId, input.featureContentId, 'Authored feature content changed');
  assert.deepEqual(current.origin, input.origin, 'Generated origin changed');
  if (committed) assert.equal(current.status, '', 'Committed feature must remain clean');
  else {
    const changed = shellFree(['git', 'diff', '--name-only', 'HEAD'], source).split('\n').filter(Boolean);
    assert.ok(changed.length > 0, 'Actual authored feature changes are required');
    assert.ok(changed.every((file) => input.changedPaths.includes(file) || ['tools/quality/git-hooks/pre-commit', 'tools/quality/git-hooks/pre-push'].includes(file)), 'Unexpected pre-commit source change');
  }
  return current;
};
async function phase(id, argv, options = {}) {
  const before = guard();
  const started = new Date();
  const relative = `logs/${String(commands.length + 1).padStart(2, '0')}-${id}.log`;
  const filename = path.join(output, relative);
  writeFileSync(filename, `argv: ${JSON.stringify(argv)}\ncwd: ${source}\nstarted: ${started.toISOString()}\nbefore: ${JSON.stringify(before)}\n`);
  const child = processTools.spawnOwned(argv[0], argv.slice(1), { cwd: source, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let wire = '';
  let smokePassed = false;
  let smokeStarted = false;
  let failure;
  const closed = new Promise((resolve) => child.once('close', (exit, signal) => resolve({ exit, signal })));
  const children = (pid) => {
    const result = spawnSync('ps', ['--no-headers', '--ppid', String(pid), '-o', 'pid='], { encoding: 'utf8' });
    assert.ok(result.status === 0 || result.status === 1, 'Owned process table unavailable');
    return result.stdout.trim().split(/\s+/u).filter(Boolean).flatMap((value) => [Number(value), ...children(Number(value))]);
  };
  const record = (chunk, stream) => {
    const text = chunk.toString();
    appendFileSync(filename, text);
    stream.write(text);
    wire = (wire + text).slice(-30_000);
    const ready = /READY @independent-service\/status (http:\/\/127\.0\.0\.1:\d+)/u.exec(wire);
    if (id === 'dev' && ready && !smokeStarted) {
      smokeStarted = true;
      (async () => {
        const response = await fetch(`${ready[1]}/status`, { signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { ok: true, service: 'status' });
        smokePassed = true;
        const launcher = [child.pid, ...children(child.pid)].find((pid) => {
          try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('tools/dev-environment/dev.ts'); }
          catch { return false; }
        });
        assert.ok(launcher, 'Owned standard dev launcher is required');
        appendFileSync(filename, `DEV_SMOKE passed; stopping owned launcher ${launcher} with SIGINT\n`);
        process.kill(launcher, 'SIGINT');
      })().catch(async (error) => {
        failure = String(error);
        appendFileSync(filename, `${failure}\n`);
        await processTools.stopTree(child);
      });
    }
  };
  child.stdout.on('data', (chunk) => record(chunk, process.stdout));
  child.stderr.on('data', (chunk) => record(chunk, process.stderr));
  child.once('error', (error) => { failure = String(error); appendFileSync(filename, `${failure}\n`); });
  const timeout = options.timeout ?? (id === 'dev' ? 120_000 : 20 * 60_000);
  const timer = setTimeout(() => {
    failure = `Command exceeded ${timeout}ms`;
    processTools.stopTree(child).catch((error) => { failure = String(error); });
  }, timeout);
  const result = await closed;
  clearTimeout(timer);
  try { await processTools.stopTree(child); } catch (error) { failure = String(error); }
  if (id === 'dev' && !smokePassed) failure ??= 'Real dev HTTP smoke did not pass';
  if (id === 'commit' && result.exit === 0 && !failure) {
    const next = shellFree(['git', 'rev-parse', 'HEAD'], source);
    assert.notEqual(next, expectedHead, 'An empty/transport commit cannot satisfy feature evidence');
    assert.equal(shellFree(['git', 'rev-parse', `${next}^`], source), input.baselineSha);
    expectedHead = next;
    committed = true;
    report.featureSha = next;
  }
  let after;
  try { after = guard(); } catch (error) { failure = String(error); }
  const ended = new Date();
  const entry = { phase: id, argv, exit: result.exit, signal: result.signal, started: started.toISOString(), ended: ended.toISOString(), durationMs: ended - started, log: relative, before, after, failure, execution: 'hosted-tools', ...(id === 'dev' ? { smokePassed } : {}) };
  commands.push(entry);
  appendFileSync(filename, `\nresult: ${JSON.stringify(entry)}\n`);
  save();
  if (options.allowMissingDevAccount && !failure && result.exit === 1 && wire.includes('CLOUDFLARE_ACCOUNT_ID is missing')) {
    entry.expectedExternalBlocker = 'Approved dev account/credentials are absent; no remote deployment occurred';
    report.devPreflight = { status: 'blocked', log: relative, exit: result.exit, reason: entry.expectedExternalBlocker };
    save();
    return;
  }
  if (failure || result.exit !== 0) throw new Error(`${id}: ${failure ?? `exit ${result.exit}`}`);
  if (id === 'dev-preflight') report.devPreflight = { status: 'configuration-preflight-passed', deployed: false, log: relative };
}
try {
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/agent-add-983');
  assert.equal(shellFree(['git', 'rev-parse', 'HEAD']), process.env.GITHUB_SHA);
  assert.equal(process.env.STATUS_AGENT_INPUT_CID, input.featureContentId);
  assert.equal(input.origin.sha, '98312ce0a1441185e4cd25509d4dc694424b0317');
  assert.equal(input.origin.contentId, '175118a36b314f5974159eafb6f6fcb20cd6f16cd82b0eca09c5d298ed7831ff');
  assert.equal(input.origin.dirty, false);
  assert.equal(digest(readFileSync(path.join(payload, 'status-source.bundle'))), input.bundleSha256);
  assert.equal(digest(readFileSync(path.join(payload, 'status-feature.patch'))), input.patchSha256);
  assert.ok(!existsSync(source), 'A fresh owned source checkout is required');
  shellFree(['git', 'clone', '--template=', '--branch', 'main', path.join(payload, 'status-source.bundle'), source]);
  expectedHead = input.baselineSha;
  assert.equal(shellFree(['git', 'rev-parse', 'HEAD'], source), expectedHead);
  shellFree(['git', 'switch', '-c', 'feat/status'], source);
  shellFree(['git', 'config', '--local', 'user.name', 'Independent Agent'], source);
  shellFree(['git', 'config', '--local', 'user.email', 'independent-agent@example.invalid'], source);
  shellFree(['git', 'apply', '--index', path.join(payload, 'status-feature.patch')], source);
  mkdirSync(path.join(source, '.state/tmp'), { recursive: true });
  mkdirSync(path.join(source, '.state/wrangler-logs'), { recursive: true });
  environment.TMPDIR = path.join(source, '.state/tmp');
  environment.TMP = environment.TMPDIR;
  environment.TEMP = environment.TMPDIR;
  environment.WRANGLER_LOG_PATH = path.join(source, '.state/wrangler-logs');
  processTools = await import(pathToFileURL(path.join(source, 'tools/process.ts')).href);
  ({ contentId } = await import(pathToFileURL(path.join(source, 'tools/quality/gate.ts')).href));
  report.candidate = guard();
  save();
  await phase('setup', ['pnpm', 'env:setup']);
  await phase('doctor', ['pnpm', 'env:doctor']);
  await phase('targeted-test', ['pnpm', '--filter', '@independent-service/status', 'test']);
  await phase('targeted-runtime', ['pnpm', '--filter', '@independent-service/status', 'test:runtime']);
  await phase('dev', ['pnpm', 'dev', '--', 'status']);
  await phase('pre-pr', ['pnpm', 'gate:pre-pr', '--', '--base', input.baselineSha]);
  shellFree(['git', 'add', '.template.json', 'package.json', 'pnpm-lock.yaml', 'packages/status', 'tools/quality/git-hooks'], source);
  assert.equal(shellFree(['git', 'config', '--get', 'core.hooksPath'], source), 'tools/quality/git-hooks');
  assert.ok(shellFree(['git', 'diff', '--cached', '--name-only'], source).includes('packages/status/src/index.ts'));
  await phase('commit', ['git', 'commit', '-m', 'Add generated status service with GET /status']);
  shellFree(['git', 'init', '--bare', path.join(source, '.state/status-remote.git')], source);
  shellFree(['git', 'remote', 'add', 'rehearsal', path.join(source, '.state/status-remote.git')], source);
  await phase('push', ['git', 'push', '--set-upstream', 'rehearsal', 'feat/status']);
  assert.equal(shellFree(['git', 'ls-remote', 'rehearsal', 'refs/heads/feat/status'], source).split(/\s+/u)[0], expectedHead);
  await phase('full', ['pnpm', 'gate:full']);
  await phase('ci', ['pnpm', 'gate:ci', '--', '--base', input.baselineSha]);
  await phase('build', ['pnpm', 'build']);
  await phase('dev-preflight', ['pnpm', 'deploy:preflight', '--', '--target', 'status', '--environment', 'dev'], { allowMissingDevAccount: true });
  await phase('preflight', ['pnpm', 'deploy:preflight', '--', '--target', 'status', '--environment', 'local']);
  const { toolVersions } = await import(pathToFileURL(path.join(source, 'tools/quality/evidence.ts')).href);
  const { globalChecks, packageChecks } = await import(pathToFileURL(path.join(source, 'tools/quality/definitions.ts')).href);
  const { workspacePackages } = await import(pathToFileURL(path.join(source, 'tools/quality/graph.ts')).href);
  const workspace = workspacePackages(source);
  const expectedChecks = [...globalChecks, ...workspace.flatMap((pkg) => packageChecks(pkg, 'full'))];
  const configuration = JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8')).options;
  report.versions = toolVersions(source);
  for (const mode of ['full', 'ci']) {
    const gate = JSON.parse(readFileSync(path.join(source, `artifacts/gate-${mode}-all-linux.json`), 'utf8'));
    assert.equal(gate.status, 'passed');
    assert.equal(gate.sha, expectedHead);
    assert.equal(gate.contentId, input.featureContentId);
    assert.equal(gate.variant, 'all');
    assert.deepEqual(gate.origin, input.origin);
    assert.deepEqual(gate.configuration, configuration);
    assert.deepEqual(gate.workspace, workspace);
    assert.deepEqual(gate.selected, workspace.map((pkg) => pkg.name));
    assert.equal(gate.base, mode === 'ci' ? input.baselineSha : null);
    assert.equal(gate.checks.length, expectedChecks.length);
    assert.deepEqual(gate.checks.map((check) => check.id), expectedChecks.map((check) => check.id));
    for (const [index, expected] of expectedChecks.entries()) {
      assert.deepEqual(gate.checks[index].command, expected.command);
      assert.deepEqual(gate.checks[index].requirements, expected.requirements);
    }
    assert.ok(gate.checks.every((check) => check.status === 'passed'));
    writeFileSync(path.join(output, `gate-${mode}-all-linux.json`), `${JSON.stringify(gate, null, 2)}\n`);
  }
  report.final = guard();
  shellFree(['git', 'bundle', 'create', path.join(output, 'verified-feature.bundle'), 'feat/status'], source);
  report.bundleSha256 = digest(readFileSync(path.join(output, 'verified-feature.bundle')));
  report.localPreflight = JSON.parse(readFileSync(path.join(source, 'artifacts/deploy-preflight.json'), 'utf8'));
  assert.equal(report.localPreflight.deployed, false);
  report.status = 'passed';
  report.limitations = ['Mechanical hosted execution supports an independently authored Agent feature; this script is not an Agent.', 'No Cloudflare remote deployment or dev connectivity is claimed.', 'The bootstrap and transport commits do not count as genuine feature commit/push evidence.'];
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify({ status: report.status, execution: report.execution, kind: report.kind, featureSha: report.featureSha, contentId: report.contentId, error: report.error }, null, 2));
}
