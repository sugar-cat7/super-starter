import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transport, sourceCheckout, generated, config, commands, run, digest, writeJson, guardCarrier } from './status-agent-common.mjs';

// This process alone may access Source. It ends after deleting that checkout.
guardCarrier();
assert.ok(existsSync(sourceCheckout), 'Exact approved Source checkout is required for generation');
assert.ok(!existsSync(generated), 'Generation target must start absent');
assert.equal(run(['git', 'rev-parse', 'HEAD'], sourceCheckout, 'source-head-before').trim(), config.source.sha);
assert.equal(run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], sourceCheckout, 'source-clean-before').trim(), '');
const { contentId } = await import(pathToFileURL(path.join(sourceCheckout, 'tools/quality/gate.ts')).href);
assert.equal(contentId(sourceCheckout), config.source.contentId);
writeJson('source-before.json', { head: config.source.sha, contentId: contentId(sourceCheckout), clean: true, phase: 'generation-preparation' });
run(['pnpm', 'env:setup', '--', '--javascript'], sourceCheckout, 'source-javascript-setup', 20 * 60_000);
assert.equal(run(['git', 'rev-parse', 'HEAD'], sourceCheckout, 'source-head-after-setup').trim(), config.source.sha);
assert.equal(run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], sourceCheckout, 'source-clean-after-setup').trim(), '');
assert.equal(contentId(sourceCheckout), config.source.contentId, 'Source setup must not silently alter the approved generation input');
const argv = config.initArgv;
assert.ok(Array.isArray(argv) && argv.every((value) => typeof value === 'string'));
assert.equal(argv[0], 'node');
assert.equal(argv[1], 'tools/generators/cli.ts');
assert.equal(argv[2], 'init');
assert.equal(argv.filter((value) => value === '%TARGET%').length, 1);
for (const value of ['independent-status-api', '@independent-service', 'api', '--no-install']) assert.ok(argv.includes(value));
assert.ok(!existsSync(generated), 'Actual CLI target must remain absent immediately before init');
run(argv.map((value) => value === '%TARGET%' ? generated : value), sourceCheckout, 'actual-source-cli-init', 60_000);
const state = JSON.parse(readFileSync(path.join(generated, '.template.json'), 'utf8'));
assert.equal(state.kind, 'project');
assert.equal(state.origin.sha, config.source.sha);
assert.equal(state.origin.dirty, false);
assert.match(state.origin.contentId, /^[a-f0-9]{64}$/u);

assert.equal(JSON.parse(readFileSync(path.join(generated, 'package.json'), 'utf8')).name, config.identity.name);
assert.equal(state.options.name, config.identity.name);
assert.equal(state.options.scope, config.identity.scope);
assert.equal(state.options.preset, 'api');
assert.deepEqual(state.options.features, []);
const { workspacePackages } = await import(pathToFileURL(path.join(generated, 'tools/quality/graph.ts')).href);
assert.deepEqual(workspacePackages(generated).map((pkg) => pkg.name).sort(), ['@independent-service/api', '@independent-service/contracts', '@independent-service/observability']);
const managed = Object.entries(state.managed).map(([file, hash]) => {
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
  const actual = digest(readFileSync(path.join(generated, file)));
  assert.equal(actual, hash, 'Fresh generated managed digest: ' + file);
  return { path: file, sha256: actual };
});
const generatedFiles = [];
function collectGenerated(directory, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = relative ? relative + '/' + entry.name : entry.name;
    assert.ok(!path.isAbsolute(file) && file.split('/').every((part) => part && part !== '.' && part !== '..'));
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectGenerated(absolute, file);
    else {
      assert.ok(entry.isFile(), 'No generated symlink or special path is allowed: ' + file);
      const mode = lstatSync(absolute).mode & 0o7777;
      assert.ok([0o644, 0o755].includes(mode), 'Unexpected generated first-party mode: ' + file);
      generatedFiles.push({ path: file, mode: mode.toString(8) });
    }
  }
}
collectGenerated(generated);
assert.deepEqual(generatedFiles.map((file) => file.path).sort(), [...Object.keys(state.managed), '.template.json'].sort(), 'Only the complete pristine managed inventory and template receipt may exist');
const rendered = createHash('sha256');
for (const file of Object.keys(state.managed).filter((file) => file !== '.template.json')) {
  rendered.update(file).update('\0').update(readFileSync(path.join(generated, file)));
}
const renderedContentId = rendered.digest('hex');
assert.equal(state.origin.contentId, renderedContentId, 'Generated origin must match its own pristine rendered managed bytes, not Source checkout CID');
if (config.expectedRenderedContentId !== null) assert.equal(renderedContentId, config.expectedRenderedContentId);
assert.equal(run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], sourceCheckout, 'source-clean-after-init').trim(), '');

assert.equal(contentId(sourceCheckout), config.source.contentId);
writeJson('generated-origin.json', { source: config.source, origin: state.origin, renderedContentId, generatedFiles, configuration: state.options, managed, managedCount: managed.length, commands, classification: 'Actual Source CLI generation preparation; no feature acceptance credit' });
rmSync(sourceCheckout, { recursive: true, force: false });
assert.ok(!existsSync(sourceCheckout));
writeJson('source-removed.json', { source: config.source, path: sourceCheckout, absent: true, removedAt: new Date().toISOString(), policy: 'No Source access in any subsequent generated-project phase' });
console.log('STATUS_SOURCE_REMOVED ' + JSON.stringify({ source: config.source, absent: true }));
