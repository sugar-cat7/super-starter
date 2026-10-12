import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function applyInsertion(baseline, delta) {
  assert.equal(delta.kind, 'unique-context-insertion');
  assert.equal(hash(Buffer.from(delta.replacement)), delta.replacementSha256);
  assert.equal(baseline.split(delta.anchor).length, 2, 'Fresh generated insertion anchor must occur exactly once');
  assert.equal(baseline.includes(delta.replacement), false, 'Fresh baseline already includes the authored insertion');
  const next = baseline.replace(delta.anchor, () => delta.replacement);
  assert.equal(next.split(delta.replacement).length, 2, 'Authored reverse boundary must be unique');
  assert.equal(next.replace(delta.replacement, () => delta.anchor), baseline,
    'Every fresh source byte outside the count insertion, including storage fix and all owning regression assertions, must survive');
  return next;
}
export function rebaseFeature(transport, directory) {
  const expectedFive = ['packages/api/test/runtime.test.ts', 'packages/web/src/client/notes.ts',
    'packages/web/src/routes/index.tsx', 'packages/web/test/browser/notes.spec.ts', 'packages/web/test/unit.test.ts'].sort();
  const expectedContexts = ['packages/api/src/notes.ts', 'packages/api/test/unit.test.ts'].sort();
  assert.deepEqual(Object.keys(transport.featureSeven).sort(), expectedFive);
  assert.deepEqual(Object.keys(transport.contextDeltas).sort(), expectedContexts);
  const files = {};
  for (const file of expectedContexts) {
    const before = readFileSync(file);
    assert.equal(hash(before), transport.files[file].sha256, 'Pristine fresh source before-image changed');
    const delta = transport.contextDeltas[file];
    assert.notEqual(hash(before), delta.beforeImageSha256, 'New owning Source storage repair must be present');
    const baseline = before.toString('utf8');
    assert.equal(Buffer.from(baseline).equals(before), true);
    const content = Buffer.from(applyInsertion(baseline, delta));
    const projected = Buffer.from(content.toString('utf8').replace(delta.replacement, () => delta.anchor));
    assert.equal(projected.equals(before), true, 'Whole fresh source projection must be byte-identical');
    const feature = { sha256: hash(content), base64: content.toString('base64') };
    transport.featureSeven[file] = feature;
    files[file] = {
      sourceBeforeSha256: hash(before), featureAfterSha256: feature.sha256,
      sourceProjectionSha256: hash(projected), replacementSha256: delta.replacementSha256,
      historicalBeforeSha256: delta.beforeImageSha256,
      historicalFeatureSha256: delta.authenticatedOldFeatureSha256,
      allFreshBaselineBytesPreserved: true,
    };
  }
  assert.equal(Object.keys(transport.featureSeven).length, 7);
  const proof = { schema: 1, execution: 'hosted-tools',
    scope: 'Mechanically apply Agent-authored count-only insertions onto complete committed fresh canonical baseline; no old whole API file transplant or Source repair authored here',
    origin: transport.origin, sourceReferenceCid: transport.sourceReferenceCid,
    authenticatedActorLineage: transport.authenticatedActorLineage, files,
    expectedOwningSourceNewUnitCases: 4, independentlyAuthoredExpandedCountCases: 8 };
  writeFileSync(path.join(directory, 'feature-rebase-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  writeFileSync(path.join(directory, 'transport-input.json'), JSON.stringify(transport, null, 2) + '\n');
  return proof;
}
