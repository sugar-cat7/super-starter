import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapContentId } from './web-agent-content-id.mjs';

const workspace = path.resolve(process.env.GITHUB_WORKSPACE ?? '.');
const source = path.join(workspace, 'source');
const feature = path.join(workspace, 'feature');
const support = path.join(workspace, 'support');
const out = path.join(support, 'generation-evidence');
mkdirSync(path.join(out, 'logs'), { recursive: true });
const sourceSha = '653abf13ae3a54b2434c422ab8dc6800822387c3';
const referenceCid = '8a91208bf0be87ea59f830dd11d700618bfc46c75493dd9799b0c5c3815fff25';
const authors = JSON.parse(readFileSync(path.join(support, 'payload/authored-seven.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commands = [];
function command(phase, argv, cwd = source) {
  const start = Date.now(), startedAt = new Date().toISOString();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, CI_HEAD_SHA: sourceSha, CI_BASE_SHA: sourceSha }, encoding: 'utf8', maxBuffer: 24_000_000, timeout: 15 * 60_000 });
  const log = 'logs/' + String(commands.length + 1).padStart(2, '0') + '-' + phase + '.log';
  const entry = { phase, argv, cwd, startedAt, milliseconds: Date.now() - start, exit: result.status,
    signal: result.signal, error: result.error?.message ?? null, log };
  writeFileSync(path.join(out, log), JSON.stringify(entry) + '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  commands.push(entry);
  writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  console.log(JSON.stringify(entry)); console.log(result.stdout ?? ''); console.error(result.stderr ?? '');
  assert.equal(result.status, 0, phase); assert.equal(result.signal, null, phase); assert.equal(entry.error, null, phase);
  return result.stdout.trim();
}
const cleanSource = phase => {
  assert.equal(command(phase + '-head', ['git', 'rev-parse', 'HEAD']), sourceSha);
  assert.equal(command(phase + '-clean', ['git', 'status', '--porcelain']), '');
};
function safe(relative) {
  assert.equal(path.isAbsolute(relative), false);
  assert(!relative.split('/').some(segment => !segment || segment === '.' || segment === '..'));
  assert(!relative.includes('\\'));
  const file = path.resolve(feature, relative);
  assert(file.startsWith(feature + path.sep)); assert(lstatSync(file).isFile());
  return file;
}
try {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/agent-web-983');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(authors.schema, 2);
  // Fail closed if this pinned candidate has not become the approved public Source boundary.
  const published = command('published-source-boundary', ['git', 'ls-remote', '--exit-code', 'origin', 'refs/pull/4/head']);
  assert.equal(published, sourceSha + '\trefs/pull/4/head', 'Pinned candidate is not published as canonical PR4 Source');
  cleanSource('initial-source');
  command('source-sdk-setup', ['pnpm', 'env:setup', '--', '--javascript']);
  cleanSource('prepared-source');
  const owner = await import(pathToFileURL(path.join(source, 'tools/quality/gate.ts')).href);
  assert.equal(owner.contentId(source), referenceCid);
  assert.equal(existsSync(feature), false);
  mkdirSync(feature);
  command('fresh-own-cli-init', ['node', 'tools/generators/cli.ts', 'init', '--target', feature,
    '--name', 'independent-note-web', '--scope', '@independent-web',
    '--identifier', 'com.example.independentnoteweb', '--preset', 'fullstack',
    '--features', 'd1,kv,r2', '--no-install']);
  cleanSource('after-generation-source');
  const state = JSON.parse(readFileSync(path.join(feature, '.template.json'), 'utf8'));
  assert.equal(state.kind, 'project'); assert.equal(state.lockPending, true);
  assert.equal(state.origin.sha, sourceSha); assert.equal(state.origin.dirty, false);
  assert.deepEqual(state.options, authors.configuration);
  assert.equal(existsSync(path.join(feature, 'node_modules')), false);
  assert.equal(existsSync(path.join(feature, '.git')), false);
  const rendered = createHash('sha256'), snapshots = {};
  // Preserve the renderer's insertion order; do not sort or hash reference metadata.
  for (const [relative, expected] of Object.entries(state.managed)) {
    const file = safe(relative), bytes = readFileSync(file);
    assert.equal(hash(bytes), expected, relative);
    rendered.update(relative + '\0'); rendered.update(bytes);
    snapshots[relative] = { sha256: expected, mode: lstatSync(file).mode & 0o777 };
  }
  assert.equal(rendered.digest('hex'), state.origin.contentId);
  assert.notEqual(state.origin.contentId, referenceCid);
  const walk = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    assert.equal(entry.isSymbolicLink(), false, relative);
    return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
  }).sort();
  assert.deepEqual(walk(feature), [...Object.keys(state.managed), '.template.json'].sort());
  const metadata = readFileSync(path.join(feature, '.template.json'));
  snapshots['.template.json'] = { sha256: hash(metadata), mode: lstatSync(path.join(feature, '.template.json')).mode & 0o777 };
  const fivePaths = ["packages/api/test/runtime.test.ts","packages/web/src/client/notes.ts","packages/web/src/routes/index.tsx","packages/web/test/browser/notes.spec.ts","packages/web/test/unit.test.ts"];
  const contextPaths = ["packages/api/src/notes.ts","packages/api/test/unit.test.ts"];
  assert.deepEqual(Object.keys(authors.featureFive).sort(), fivePaths.sort());
  assert.deepEqual(Object.keys(authors.beforeFive).sort(), fivePaths.sort());
  assert.deepEqual(Object.keys(authors.contextDeltas).sort(), contextPaths.sort());
  for (const [relative, entry] of Object.entries(authors.featureFive)) {
    assert.equal(hash(Buffer.from(entry.base64, 'base64')), entry.sha256, relative);
    safe(relative);
    assert.equal(snapshots[relative].sha256, authors.beforeFive[relative], 'Fresh unchanged authored before-image changed: ' + relative);
  }
  for (const [relative, delta] of Object.entries(authors.contextDeltas)) {
    safe(relative);
    assert.equal(delta.kind, 'unique-context-insertion');
    assert.equal(hash(Buffer.from(delta.replacement)), delta.replacementSha256);
    assert.match(delta.beforeImageSha256, /^[a-f0-9]{64}$/u);
    assert.match(delta.authenticatedOldFeatureSha256, /^[a-f0-9]{64}$/u);
  }
  const destination = path.join(feature, 'artifacts/agent-web-api');
  mkdirSync(path.join(destination, 'hosted-helpers'), { recursive: true });
  mkdirSync(path.join(feature, '.state/t'), { recursive: true });
  mkdirSync(path.join(destination, 'wrangler-logs'), { recursive: true });
  for (const entry of readdirSync(path.join(support, '.github/scripts')))
    if (entry.startsWith('web-agent-') && entry.endsWith('.mjs'))
      writeFileSync(path.join(destination, 'hosted-helpers', entry), readFileSync(path.join(support, '.github/scripts', entry)));
  const spec = { schema: 1, origin: state.origin, configuration: state.options,
    pendingContentId: bootstrapContentId(feature), files: snapshots, featureSeven: authors.featureFive, contextDeltas: authors.contextDeltas,
    authenticatedActorLineage: authors.lineage,
    authoredCarrierSha: authors.authenticatedCarrierSha, sourceReferenceCid: referenceCid };
  writeFileSync(path.join(destination, 'transport-input.json'), JSON.stringify(spec, null, 2) + '\n');
  writeFileSync(path.join(destination, 'fresh-generation-receipt.json'), JSON.stringify({ sourceSha, referenceCid,
    origin: state.origin, configuration: state.options, files: Object.keys(snapshots).length,
    insertionOrderRenderedCidVerified: true, allManagedHashesVerified: true, sdkInstalledBeforeGeneration: true,
    generatedSdkAbsent: true, generatedGitAbsent: true, sourceCommands: commands, pendingContentId: spec.pendingContentId }, null, 2) + '\n');
  cleanSource('before-source-removal');
  assert.equal(owner.contentId(source), referenceCid, 'Source content changed before removal');
  // Only the exact checkout this workflow created; no shared stores or unknown paths.
  assert.equal(path.dirname(source), workspace); assert.equal(path.basename(source), 'source');
  rmSync(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  assert.equal(existsSync(source), false);
  const removal = { removedSource: source, sourceSha, cleanBeforeRemoval: true,
    noSourceCheckoutRemains: true, scope: 'Generation process ends here before any feature helper runs' };
  writeFileSync(path.join(destination, 'source-removal-receipt.json'), JSON.stringify(removal, null, 2) + '\n');
  if (process.env.GITHUB_ENV) writeFileSync(process.env.GITHUB_ENV,
    'TMPDIR=' + path.join(feature, '.state/t') + '\nTMP=' + path.join(feature, '.state/t') +
    '\nTEMP=' + path.join(feature, '.state/t') + '\nWRANGLER_LOG_PATH=' + path.join(destination, 'wrangler-logs') + '\n',
    { flag: 'a' });
  console.log('WEB_AGENT_GENERATION ' + JSON.stringify({ ...removal, origin: state.origin, pendingContentId: spec.pendingContentId }));
} catch (error) {
  writeFileSync(path.join(out, 'failed.json'), JSON.stringify({ status: 'failed', sourceSha, commands, error: String(error) }, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
}
