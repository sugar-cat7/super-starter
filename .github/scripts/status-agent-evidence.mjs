import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Mechanical evidence transport only. Never execute Source or feature commands,
// change permissions, download another workflow's artifacts, or claim Agent work.
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/agent-add-983');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
const grouped = process.env.STATUS_AGENT_EVIDENCE_GROUP !== undefined;
const output = path.join(process.cwd(), grouped ? '.state/evidence-download/artifacts/hosted-agent-add' : 'artifacts/hosted-agent-add');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
function collect(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    assert.ok(!relative.split('/').includes('..') && !path.isAbsolute(relative));
    if (relative === 'evidence-index.json') continue;
    if (entry.isDirectory()) collect(path.join(directory, entry.name), relative);
    else if (entry.isFile()) {
      const bytes = readFileSync(path.join(directory, entry.name));
      files.push({ path: relative, size: bytes.length, sha256: digest(bytes), raw: bytes });
    } else throw new Error('Unexpected evidence link/special file: ' + relative);
  }
}
assert.ok(existsSync(output), 'Actual owned preparation or phase output must exist');
collect(output);
assert.ok(files.length > 0);
const chunkBytes = 256 * 1024;
const groupBudget = 768 * 1024;
const groups = [[]];
const fileManifest = [];
for (const file of files) {
  const pieces = [];
  const count = Math.max(1, Math.ceil(file.size / chunkBytes));
  for (let part = 0; part < count; part++) {
    const offset = part * chunkBytes;
    const bytes = file.raw.subarray(offset, Math.min(file.size, offset + chunkBytes));
    const record = { path: file.path, fileSize: file.size, fileSha256: file.sha256, part, parts: count, offset, size: bytes.length, sha256: digest(bytes), bytes: bytes.toString('base64') };
    let group = groups.at(-1);
    if (Buffer.byteLength(JSON.stringify([...group, record])) > groupBudget && group.length) {
      groups.push([]);
      group = groups.at(-1);
    }
    assert.ok(Buffer.byteLength(JSON.stringify([record])) <= groupBudget, 'Every evidence part must fit its fixed transport budget');
    group.push(record);
    pieces.push({ part, group: groups.length - 1, offset, size: bytes.length, sha256: record.sha256 });
  }
  fileManifest.push({ path: file.path, size: file.size, sha256: file.sha256, parts: pieces });
}
const manifest = { schema: 1, execution: 'hosted-tools', kind: 'same-workflow-evidence-transport', transportSha: process.env.GITHUB_SHA, groupCount: groups.length, chunkBytes, groupBudget, files: fileManifest };
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = digest(manifestBytes);
if (!grouped) {
  writeFileSync(path.join(output, 'evidence-index.json'), JSON.stringify(manifest, null, 2) + '\n');
  assert.ok(process.env.GITHUB_OUTPUT, 'Current main job must publish its own same-workflow group matrix');
  appendFileSync(process.env.GITHUB_OUTPUT, 'matrix=' + JSON.stringify({ group: groups.map((_, index) => index) }) + '\n');
  console.log('STATUS_AGENT_EVIDENCE_MANIFEST ' + JSON.stringify({ manifestSha256, manifest }));
} else {
  const original = JSON.parse(readFileSync(path.join(output, 'evidence-index.json'), 'utf8'));
  assert.deepEqual(manifest, original, 'Downloaded same-workflow evidence must remain byte/digest complete');
  const group = Number(process.env.STATUS_AGENT_EVIDENCE_GROUP);
  assert.ok(Number.isInteger(group) && group >= 0 && group < groups.length);
  const envelope = Buffer.from(JSON.stringify({ schema: 1, execution: 'hosted-tools', kind: 'same-workflow-evidence-group', transportSha: process.env.GITHUB_SHA, manifestSha256, group, groupCount: groups.length, parts: groups[group] }));
  assert.ok(envelope.length <= groupBudget + 512);
  const chunks = envelope.toString('base64').match(/.{1,6000}/gu) ?? [];
  console.log('STATUS_AGENT_GROUP_BEGIN ' + JSON.stringify({ encoding: 'utf8+base64', size: envelope.length, sha256: digest(envelope), chunks: chunks.length, transportSha: process.env.GITHUB_SHA, manifestSha256, group, groupCount: groups.length }));
  chunks.forEach((chunk, index) => console.log('STATUS_AGENT_GROUP_CHUNK ' + index + ' ' + chunk));
  console.log('STATUS_AGENT_GROUP_END');
}
