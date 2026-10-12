import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

// Evidence only: no Source/project execution, credentials, environment dumps,
// cross-workflow downloads, or claimed Agent authorship.
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/agent-add-983');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
const output = path.join(process.cwd(), 'artifacts/hosted-agent-add');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
function collect(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    assert.ok(!relative.split('/').includes('..') && !path.isAbsolute(relative));
    if (entry.isDirectory()) collect(path.join(directory, entry.name), relative);
    else if (entry.isFile()) {
      const bytes = readFileSync(path.join(directory, entry.name));
      files.push({ path: relative, size: bytes.length, sha256: digest(bytes), bytes: bytes.toString('base64') });
    } else throw new Error('Unexpected evidence link/special file: ' + relative);
  }
}
assert.ok(existsSync(output), 'Actual preparation or phase output must exist');
collect(output);
assert.ok(files.length > 0, 'Nonempty actual evidence is required');
const plain = Buffer.from(JSON.stringify({ schema: 1, execution: 'hosted-tools', transportSha: process.env.GITHUB_SHA, files }));
function emit(marker, encoding, bytes) {
  const chunks = bytes.toString('base64').match(/.{1,6000}/gu) ?? [];
  console.log(marker + '_BEGIN ' + JSON.stringify({ encoding, size: bytes.length, sha256: digest(bytes), chunks: chunks.length, transportSha: process.env.GITHUB_SHA, files: files.length }));
  chunks.forEach((chunk, index) => console.log(marker + '_CHUNK ' + index + ' ' + chunk));
  console.log(marker + '_END');
}
emit('STATUS_AGENT_ARCHIVE', 'gzip+base64', gzipSync(plain));
emit('STATUS_AGENT_PLAIN', 'utf8+base64', plain);
