import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertInput } from './web-agent-input.mjs';
import { recordCommand, directory, commandsFile } from './web-agent-run.mjs';

let identityFailure = null;
try {
  await assertInput();
  for (const [phase, argv] of [
    ['raw-feature-commit', ['git', 'cat-file', '-p', 'HEAD']],
    ['raw-baseline-commit', ['git', 'cat-file', '-p', 'main']],
    ['raw-feature-tree', ['git', 'ls-tree', '-r', '--long', 'HEAD']],
    ['raw-baseline-tree', ['git', 'ls-tree', '-r', '--long', 'main']],
    ['raw-feature-diff', ['git', 'show', '--format=fuller', '--stat', '--patch', 'HEAD']],
    ['raw-hook-config', ['git', 'config', '--show-origin', '--get-regexp', '^core[.]hooks[pP]ath$']],
    ['raw-bare-ref', ['git', '--git-dir', path.join(directory, 'owned-origin.git'), 'rev-parse', 'refs/heads/feat/notes-count']],
  ]) await recordCommand(phase, argv, assertInput, assertInput);
  const list = await recordCommand('raw-git-object-list', ['git', 'rev-list', '--objects', 'main', 'HEAD'], assertInput, assertInput);
  const objectIds = [...new Set(readFileSync(path.join(directory, list.log), 'utf8').split('\n')
    .map(line => /^([a-f0-9]{40})(?: .*)?$/u.exec(line)?.[1]).filter(Boolean))];
  if (!objectIds.length) throw new Error('Actual Git object list empty');
  const inputBefore = await assertInput(), startedAt = new Date().toISOString(), start = performance.now();
  const argv = ['git', 'cat-file', '--batch'];
  const result = spawnSync(argv[0], argv.slice(1), { cwd: process.cwd(), env: process.env,
    input: objectIds.join('\n') + '\n', maxBuffer: 128_000_000, timeout: 60_000 });
  const inputAfter = await assertInput();
  const commands = JSON.parse(readFileSync(commandsFile, 'utf8'));
  const log = 'logs/' + String(commands.length + 1).padStart(2, '0') + '-raw-git-objects.log';
  const entry = { phase: 'raw-git-objects', argv, exit: result.status, signal: result.signal,
    spawnError: result.error?.message ?? null, inputGuardError: null, inputBefore, inputAfter,
    cwd: process.cwd(), startedAt, milliseconds: Math.round(performance.now() - start), log,
    stdin: { objects: objectIds.length, sha256: createHash('sha256').update(objectIds.join('\n') + '\n').digest('hex') },
    stdoutBytes: result.stdout?.length ?? 0,
    scope: 'Actual binary Git object bytes; exported as base64 with verified SHA/type/size below' };
  writeFileSync(path.join(directory, log), JSON.stringify(entry) + '\n' + (result.stderr?.toString('utf8') ?? ''));
  commands.push(entry); writeFileSync(commandsFile, JSON.stringify(commands, null, 2) + '\n'); console.log(JSON.stringify(entry));
  if (entry.exit !== 0 || entry.signal || entry.spawnError) throw new Error('Actual Git batch failed');
  const raw = result.stdout, objects = []; let offset = 0;
  for (const expected of objectIds) {
    const newline = raw.indexOf(10, offset);
    if (newline < offset) throw new Error('Git object header truncated');
    const header = /^([a-f0-9]{40}) (commit|tree|blob) ([0-9]+)$/u.exec(raw.subarray(offset, newline).toString('ascii'));
    if (!header || header[1] !== expected) throw new Error('Git object header/SHA mismatch');
    const size = Number(header[3]), begin = newline + 1, end = begin + size;
    if (!Number.isSafeInteger(size) || end >= raw.length || raw[end] !== 10) throw new Error('Git object body truncated');
    const bytes = raw.subarray(begin, end);
    const calculated = createHash('sha1').update(header[2] + ' ' + size + '\0').update(bytes).digest('hex');
    if (calculated !== expected) throw new Error('Actual Git object bytes do not hash to SHA');
    objects.push({ sha: expected, type: header[2], bytes: size, base64: bytes.toString('base64') });
    offset = end + 1;
  }
  if (offset !== raw.length) throw new Error('Unexpected trailing Git batch bytes');
  writeFileSync(path.join(directory, 'git-objects.json'), JSON.stringify({ schema: 1, execution: 'hosted-tools',
    scope: 'Complete objects reachable from actual fresh baseline main and genuine feature HEAD; no ZIP or pack decoder needed',
    inputBefore, inputAfter, objectIds, objects }, null, 2) + '\n');
  await assertInput();
} catch (error) { identityFailure = String(error); process.exitCode = 1; console.error(error); }
// Always export existing failures too; no archive decoder or expanded permissions.
const picks = new Set();
const collect = (base, prefix = '') => {
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const file = path.join(base, entry.name), relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Unexpected evidence symlink: ' + relative);
    if (entry.isDirectory()) {
      if (!['owned-origin.git', 'hosted-helpers'].includes(entry.name)) collect(file, relative);
    } else if (/\.(?:json|log|txt|xml)$/u.test(entry.name)) picks.add(file);
  }
};
for (const root of ['artifacts', 'packages/api/artifacts', 'packages/web/artifacts', 'packages/web/test-results',
  path.resolve('../support/generation-evidence')]) collect(root, root);
if (existsSync('.template.json')) picks.add('.template.json');
const entries = [...picks].sort().map(file => {
  const bytes = readFileSync(file), content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes)) throw new Error('Non-UTF8 audit file: ' + file);
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    chunks: Math.max(1, Math.ceil(content.length / 12000)), content };
});
console.log('WEB_AGENT_AUDIT_BEGIN ' + JSON.stringify({ schema: 1, execution: 'hosted-tools',
  scope: 'Plain evidence export only; no Agent approval', identityFailure,
  files: entries.map(({ content, ...entry }) => entry) }));
for (const entry of entries) {
  for (let index = 0; index < entry.chunks; index++)
    console.log('WEB_AGENT_AUDIT_CHUNK ' + JSON.stringify({ file: entry.file, bytes: entry.bytes,
      sha256: entry.sha256, index, chunks: entry.chunks, content: entry.content.slice(index * 12000, (index + 1) * 12000) }));
}
console.log('WEB_AGENT_AUDIT_END ' + JSON.stringify({ files: entries.length,
  aggregateSha256: createHash('sha256').update(entries.map(({ content, ...entry }) => JSON.stringify(entry)).join('\n')).digest('hex'),
  identityFailure }));
if (!identityFailure) await assertInput();
