import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSource, bootstrapContentId, identify, transport } from './web-agent-input.mjs';
import { recordCommand, directory } from './web-agent-run.mjs';

const digest = body => createHash('sha256').update(body).digest('hex');
const removal = JSON.parse(readFileSync(path.join(directory, 'source-removal-receipt.json'), 'utf8'));
if (existsSync(removal.removedSource) || !removal.noSourceCheckoutRemains || removal.sourceSha !== '460ad19c970adaab7231795f3438943d9158b135') throw new Error('Fresh Source removal proof missing');
const initial = () => {
  const state = assertSource('pristine');
  if (digest(readFileSync('.template.json')) !== transport.files['.template.json'].sha256 ||
      bootstrapContentId(process.cwd()) !== transport.pendingContentId || state.lockPending !== true)
    throw new Error('Complete pristine pending setup input changed');
  return { origin: state.origin, contentId: transport.pendingContentId, supportSha: process.env.GITHUB_SHA,
    featureSha: null, clean: null, stage: 'pristine-pending-owned-git' };
};
await recordCommand('bootstrap-git-init', ['git', 'init', '--initial-branch=main'], initial, () => identify(false, 'pristine'));
const pending = () => { initial(); return identify(false, 'pristine'); };
await recordCommand('bootstrap-git-config', ['git', 'config', '--local', 'user.name', 'Codex independent verifier'], pending, pending);
await recordCommand('bootstrap-git-config', ['git', 'config', '--local', 'user.email', 'agent-web@example.invalid'], pending, pending);
await recordCommand('bootstrap-setup', ['pnpm', 'env:setup'], pending, () => identify(true, 'pristine'));
const pristine = await identify(true, 'pristine');
const state = assertSource('pristine');
if (state.lockPending !== false || !state.lockId || digest(readFileSync('pnpm-lock.yaml')) !== state.lockId)
  throw new Error('Canonical setup did not finalize its own lock');
const git = argv => execFileSync('git', argv, { encoding: 'utf8' }).trim();
if (git(['config', '--get', 'core.hooksPath']) !== 'tools/quality/git-hooks')
  throw new Error('Canonical hooks missing');
const samePristine = async () => {
  const input = await identify(true, 'pristine');
  if (input.contentId !== pristine.contentId) throw new Error('Prepared pristine content changed');
  return input;
};
await recordCommand('baseline-stage', ['git', 'add', '--all'], samePristine, samePristine);
await recordCommand('baseline-commit', ['git', 'commit', '-m', 'Record complete pristine generated fullstack baseline after standard setup'], samePristine, samePristine);
const baseSha = git(['rev-parse', 'HEAD']);
const baseline = await samePristine();
const expectedPaths = [...Object.keys(transport.files), 'pnpm-lock.yaml'].sort();
const trackedPaths = git(['ls-files']).split('\n').filter(Boolean).sort();
if (!baseline.clean || JSON.stringify(trackedPaths) !== JSON.stringify(expectedPaths))
  throw new Error('Baseline must contain every pristine generated file plus canonical lock and be clean');
const baselineFiles = Object.fromEntries(expectedPaths.map(file => [file, {
  sha256: digest(readFileSync(file)),
  gitBlob: createHash('sha1').update(`blob ${readFileSync(file).length}\0`).update(readFileSync(file)).digest('hex'),
}]));
for (const [file, expected] of Object.entries(transport.files)) {
  if (file !== '.template.json' && baselineFiles[file].sha256 !== expected.sha256)
    throw new Error(`Pristine baseline file changed: ${file}`);
}
writeFileSync(path.join(directory, 'pristine-baseline-proof.json'), JSON.stringify({
  baseSha, input: baseline, sourceFiles: transport.files, actualFiles: baselineFiles,
  scope: 'All fresh generated files present; canonical setup alone finalized metadata and added the lock',
}, null, 2) + '\n');
await recordCommand('bootstrap-branch', ['git', 'switch', '-c', 'feat/notes-count'], samePristine, samePristine);
const metadataBefore = digest(readFileSync('.template.json'));
const lockBefore = digest(readFileSync('pnpm-lock.yaml'));
for (const [file, feature] of Object.entries(transport.featureSeven)) {
  const body = Buffer.from(feature.base64, 'base64');
  if (digest(body) !== feature.sha256 || digest(readFileSync(file)) !== transport.files[file].sha256)
    throw new Error(`Authored delta or pristine before-image changed: ${file}`);
  writeFileSync(file, body);
}
const prepared = await identify();
if (digest(readFileSync('.template.json')) !== metadataBefore || digest(readFileSync('pnpm-lock.yaml')) !== lockBefore)
  throw new Error('Authored delta modified finalized metadata or lock');
const featurePaths = Object.keys(transport.featureSeven).sort();
if (JSON.stringify(git(['diff', '--name-only']).split('\n').filter(Boolean).sort()) !== JSON.stringify(featurePaths))
  throw new Error('Authored delta must change exactly its seven files');
writeFileSync(path.join(directory, 'feature-apply-proof.json'), JSON.stringify({
  before: baseline, after: prepared, featurePaths, featureSeven: transport.featureSeven,
  protectedOtherFiles: Object.keys(transport.files).length - featurePaths.length,
  metadataUnchanged: true, lockUnchanged: true,
}, null, 2) + '\n');
const samePrepared = async () => {
  const input = await identify();
  if (input.contentId !== prepared.contentId) throw new Error('Prepared feature content changed');
  return input;
};
await recordCommand('feature-stage', ['git', 'add', '--', ...featurePaths], samePrepared, samePrepared);
await recordCommand('commit', ['git', 'commit', '-m', 'Add reactive note count with normal, failure and stale response regressions'], samePrepared, samePrepared);
const final = await samePrepared();
if (!final.clean || final.featureSha === baseSha ||
    JSON.stringify(git(['diff', '--name-only', baseSha, 'HEAD']).split('\n').filter(Boolean).sort()) !== JSON.stringify(featurePaths))
  throw new Error('Genuine feature commit is not clean, nonempty and exactly seven files');
const { assertCheckout } = await import(pathToFileURL(path.resolve('tools/quality/checkout.ts')).href);
assertCheckout(process.cwd(), final.featureSha);
const fixed = { ...final, baseSha, sourcePendingContentId: transport.pendingContentId,
  scope: 'Fixed after genuine normal feature commit on complete pristine baseline; all fresh source and authored delta hashes verified' };
writeFileSync(path.join(directory, 'input-fixed.json'), JSON.stringify(fixed, null, 2) + '\n', { mode: 0o400 });
chmodSync(path.join(directory, 'input-fixed.json'), 0o400);
if (process.env.GITHUB_ENV)
  appendFileSync(process.env.GITHUB_ENV, `CI_BASE_SHA=${baseSha}\nCI_HEAD_SHA=${final.featureSha}\n`);
console.log(JSON.stringify({ phase: 'fixed-after-genuine-commit', ...fixed }));
